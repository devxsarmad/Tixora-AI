import { HttpError } from '../../shared/http-error.js';
import { generateGroundedAnswer, selectAssistantToolCalls } from './llmClient.js';
import { countAccessibleTasks, resolveAssistantScope } from './assistant.repository.js';
import { retrieveRelevantChunks } from './embedding.service.js';
import type { AskAssistantInput, ConfirmAssistantActionsInput } from './assistant.schemas.js';
import {
  assistantToolDefinitions,
  buildPendingAssistantAction,
  executeAssistantToolCall,
  isMutatingAssistantTool,
  logAssistantActionEvent,
  validateAssistantToolCall,
  type AssistantToolCall,
  type AssistantToolResult,
  type PendingAssistantAction,
  type ToolName
} from './tools.js';
import type { RetrievalChunk } from './types.js';

function buildContext(chunks: RetrievalChunk[]) {
  return chunks
    .map((chunk, index) => {
      const sourceLabel = chunk.contentType === 'comment'
        ? 'comment ' + chunk.sourceId + ' on task ' + chunk.taskId
        : 'task ' + chunk.taskId;
      return [
        'SOURCE ' + (index + 1),
        'Type: ' + chunk.contentType,
        'Source: ' + sourceLabel,
        'Task ID: ' + chunk.taskId,
        'Project ID: ' + chunk.projectId,
        'Task title: ' + chunk.taskTitle,
        'Content: ' + chunk.contentText
      ].join('\n');
    })
    .join('\n\n');
}

type StoredPendingAction = {
  userId: string;
  orgId: string;
  toolName: ToolName;
  expiresAt: number;
  resolved: boolean;
};

const pendingActionStore = new Map<string, StoredPendingAction>();
const pendingActionTtlMs = 10 * 60 * 1000;

function storePendingActions(params: { userId: string; orgId: string; actions: PendingAssistantAction[] }) {
  const expiresAt = Date.now() + pendingActionTtlMs;
  for (const action of params.actions) {
    pendingActionStore.set(action.id, {
      userId: params.userId,
      orgId: params.orgId,
      toolName: action.toolName,
      expiresAt,
      resolved: false
    });
  }
}

function takePendingAction(params: { id: string; userId: string; orgId: string; toolName: ToolName }) {
  const stored = pendingActionStore.get(params.id);
  if (!stored || stored.resolved || stored.expiresAt < Date.now()) {
    if (stored) pendingActionStore.delete(params.id);
    return 'action already resolved or expired';
  }

  if (stored.userId !== params.userId || stored.orgId !== params.orgId || stored.toolName !== params.toolName) {
    return 'action already resolved or expired';
  }

  stored.resolved = true;
  pendingActionStore.set(params.id, stored);
  return null;
}

function emptySources() {
  return [] as [];
}

const assistantToolNames: ToolName[] = [
  'list_overdue_tasks',
  'list_tasks',
  'summarize_assignee_workload',
  'search_tasks',
  'create_task',
  'update_task_status',
  'update_task_priority',
  'update_task_due_date',
  'add_task_comment'
];

function isAssistantToolName(value: string): value is ToolName {
  return assistantToolNames.includes(value as ToolName);
}

function getCurrentDateContext() {
  return 'Current date: ' + new Date().toISOString().slice(0, 10) + '. Interpret relative dates like tomorrow from this date.';
}

function withDefaultProjectId(call: AssistantToolCall, projectId?: string): AssistantToolCall {
  if (!projectId) return call;

  try {
    const args = call.argumentsText ? JSON.parse(call.argumentsText) as Record<string, unknown> : {};
    if (args.projectId) return call;

    return {
      ...call,
      argumentsText: JSON.stringify({ ...args, projectId })
    };
  } catch {
    return call;
  }
}

function buildToolContext(toolResults: AssistantToolResult[]) {
  if (toolResults.length === 0) return '';

  return toolResults
    .map((toolResult) =>
      [
        'TOOL RESULT',
        'Tool: ' + toolResult.toolName,
        'Status: ' + (toolResult.ok ? 'ok' : 'error'),
        'Result: ' + JSON.stringify(toolResult.result)
      ].join('\n')
    )
    .join('\n\n');
}

function isPostgresErrorCode(error: unknown, codes: string[]) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    codes.includes((error as { code: string }).code)
  );
}

function toAssistantHttpError(error: unknown, fallback: string): HttpError {
  if (error instanceof HttpError) return error;

  if (isPostgresErrorCode(error, ['42P01', '42704', '42883', '0A000'])) {
    return new HttpError(
      503,
      'Ask Tixora embeddings are not ready. Run the latest database migration and make sure pgvector is installed.',
      'ASSISTANT_EMBEDDINGS_NOT_READY'
    );
  }

  return new HttpError(
    502,
    error instanceof Error ? error.message : fallback,
    'ASSISTANT_MODEL_ERROR'
  );
}

function buildDeterministicReadToolCall(query: string, projectId?: string): AssistantToolCall | null {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const mentionsTickets = /\b(task|tasks|ticket|tickets|tikcet|tikcets)\b/.test(normalized);
  const asksForList = /\b(which|show|list|find|get|what)\b/.test(normalized);

  if (!mentionsTickets || !asksForList) return null;

  const args: Record<string, unknown> = {};
  if (projectId) args.projectId = projectId;

  if (/\bunassigned\b|no assignee|without assignee|no owner|without owner/.test(normalized)) {
    args.assigneeState = 'unassigned';
  }

  if (/\bblocked\b/.test(normalized)) args.status = 'blocked';
  if (/\bdone\b|completed/.test(normalized)) args.status = 'done';
  if (/in progress|progressing/.test(normalized)) args.status = 'in_progress';
  if (/to do|todo|not started/.test(normalized)) args.status = 'todo';

  if (/\burgent\b/.test(normalized)) args.priority = 'urgent';
  else if (/\bhigh priority\b|priority high/.test(normalized)) args.priority = 'high';
  else if (/\bmedium priority\b|priority medium/.test(normalized)) args.priority = 'medium';
  else if (/\blow priority\b|priority low/.test(normalized)) args.priority = 'low';

  if (/\boverdue\b/.test(normalized)) args.due = 'overdue';
  if (/\bupcoming\b/.test(normalized)) args.due = 'upcoming';

  if (Object.keys(args).length === (projectId ? 1 : 0)) return null;

  return {
    id: 'direct_' + Date.now(),
    name: 'list_tasks',
    argumentsText: JSON.stringify(args)
  };
}

function isTaskCountQuestion(query: string) {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const asksForCount =
    normalized.includes('how many') ||
    normalized.includes('no of') ||
    normalized.includes('no os') ||
    normalized.startsWith('no ') ||
    normalized.includes('number of') ||
    normalized.includes('count') ||
    normalized.includes('total');
  const mentionsTasks =
    normalized.includes('task') ||
    normalized.includes('tasks') ||
    normalized.includes('ticket') ||
    normalized.includes('tickets') ||
    normalized.includes('tikcet') ||
    normalized.includes('tikcets');

  return asksForCount && mentionsTasks;
}

function buildTaskCountAnswer(counts: { total: number; todo: number; inProgress: number; blocked: number; done: number }, scopedToProject: boolean) {
  const scopeLabel = scopedToProject ? 'this project' : 'the accessible organization workspace';
  return (
    'In ' + scopeLabel + ', we have ' + counts.total + ' ticket' + (counts.total === 1 ? '' : 's') +
    ': ' + counts.todo + ' to do, ' +
    counts.inProgress + ' in progress, ' +
    counts.blocked + ' blocked, and ' +
    counts.done + ' done.'
  );
}

function buildToolSuccessAnswer(toolResults: AssistantToolResult[]) {
  const createResult = toolResults.find((result) => result.ok && result.toolName === 'create_task');
  if (createResult && typeof createResult.result === 'object' && createResult.result !== null && 'title' in createResult.result) {
    const task = createResult.result as { title?: string; dueAt?: string | null; assignees?: unknown[] };
    const assigneeCount = Array.isArray(task.assignees) ? task.assignees.length : 0;
    return (
      "Created ticket " +
      (task.title ? '"' + task.title + '"' : '') +
      (assigneeCount > 0 ? ' and assigned it to ' + assigneeCount + ' member' + (assigneeCount === 1 ? '' : 's') : '') +
      (task.dueAt ? ' with due date ' + task.dueAt : '') +
      '.'
    );
  }

  const statusResult = toolResults.find((result) => result.ok && result.toolName === 'update_task_status');
  if (statusResult && typeof statusResult.result === 'object' && statusResult.result !== null && 'title' in statusResult.result) {
    const task = statusResult.result as { title?: string; status?: string };
    return 'Updated ticket ' + (task.title ? '"' + task.title + '"' : '') + ' to ' + (task.status ?? 'the requested status') + '.';
  }

  const priorityResult = toolResults.find((result) => result.ok && result.toolName === 'update_task_priority');
  if (priorityResult && typeof priorityResult.result === 'object' && priorityResult.result !== null && 'title' in priorityResult.result) {
    const task = priorityResult.result as { title?: string; priority?: string };
    return 'Updated ticket ' + (task.title ? '"' + task.title + '"' : '') + ' priority to ' + (task.priority ?? 'the requested priority') + '.';
  }

  const dueDateResult = toolResults.find((result) => result.ok && result.toolName === 'update_task_due_date');
  if (dueDateResult && typeof dueDateResult.result === 'object' && dueDateResult.result !== null && 'title' in dueDateResult.result) {
    const task = dueDateResult.result as { title?: string; dueAt?: string | null };
    return 'Updated ticket ' + (task.title ? '"' + task.title + '"' : '') + ' due date' + (task.dueAt ? ' to ' + task.dueAt : '') + '.';
  }

  const commentResult = toolResults.find((result) => result.ok && result.toolName === 'add_task_comment');
  if (commentResult) return 'Added the comment to the ticket.';

  const listTasksResult = toolResults.find((result) => result.ok && result.toolName === 'list_tasks');
  if (listTasksResult && Array.isArray(listTasksResult.result)) {
    const tasks = listTasksResult.result as Array<{ title?: string; status?: string; priority?: string; dueAt?: string | null; assigneeCount?: number }>;
    if (tasks.length === 0) return 'No matching tickets found in this scope.';
    const labels = tasks.slice(0, 8).map((task) => {
      const due = task.dueAt ? ', due ' + new Date(task.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      const assignees = typeof task.assigneeCount === 'number' ? ', ' + task.assigneeCount + ' assignee' + (task.assigneeCount === 1 ? '' : 's') : '';
      return (task.title ?? 'Untitled ticket') + ' (' + (task.status ?? 'unknown') + ', ' + (task.priority ?? 'unknown') + due + assignees + ')';
    }).join('; ');
    return 'I found ' + tasks.length + ' matching ticket' + (tasks.length === 1 ? '' : 's') + ': ' + labels + (tasks.length > 8 ? '; and more.' : '.');
  }

  const searchResult = toolResults.find((result) => result.ok && result.toolName === 'search_tasks');
  if (searchResult && Array.isArray(searchResult.result)) {
    const tasks = searchResult.result as Array<{ title?: string }>;
    if (tasks.length === 0) return 'No matching tickets found in this scope.';
    const titles = tasks.slice(0, 6).map((task) => task.title).filter(Boolean).join(', ');
    return 'I found ' + tasks.length + ' matching ticket' + (tasks.length === 1 ? '' : 's') + ': ' + titles + (tasks.length > 6 ? ', and more.' : '.');
  }

  const workloadResult = toolResults.find((result) => result.ok && result.toolName === 'summarize_assignee_workload');
  if (workloadResult && Array.isArray(workloadResult.result)) {
    const rows = workloadResult.result as Array<{
      userId?: string;
      displayName?: string;
      projectName?: string;
      counts?: { todo?: number; inProgress?: number; blocked?: number; done?: number; overdue?: number };
    }>;
    if (rows.length === 0) return 'I found no project members or assigned tickets in this scope.';

    const groupedRows = new Map<string, {
      name: string;
      counts: { todo: number; inProgress: number; blocked: number; done: number; overdue: number };
    }>();

    for (const row of rows) {
      const key = row.userId ?? row.displayName ?? 'unknown';
      const current = groupedRows.get(key) ?? {
        name: row.displayName ?? 'Unnamed member',
        counts: { todo: 0, inProgress: 0, blocked: 0, done: 0, overdue: 0 }
      };
      current.counts.todo += row.counts?.todo ?? 0;
      current.counts.inProgress += row.counts?.inProgress ?? 0;
      current.counts.blocked += row.counts?.blocked ?? 0;
      current.counts.done += row.counts?.done ?? 0;
      current.counts.overdue += row.counts?.overdue ?? 0;
      groupedRows.set(key, current);
    }

    const summaries = [...groupedRows.values()].map((row) => {
      const total = row.counts.todo + row.counts.inProgress + row.counts.blocked + row.counts.done;
      return (
        row.name + ': ' + total + ' ticket' + (total === 1 ? '' : 's') +
        ' (' + row.counts.todo + ' to do, ' +
        row.counts.inProgress + ' in progress, ' +
        row.counts.blocked + ' blocked, ' +
        row.counts.done + ' done, ' +
        row.counts.overdue + ' overdue)'
      );
    });

    if (summaries.length === 1) return summaries[0] + '.';
    return 'Workload by project member: ' + summaries.join('; ') + '.';
  }

  const overdueResult = toolResults.find((result) => result.ok && result.toolName === 'list_overdue_tasks');
  if (overdueResult && Array.isArray(overdueResult.result)) {
    const tasks = overdueResult.result as Array<{ title?: string; status?: string; dueAt?: string | null }>;
    if (tasks.length === 0) return 'No overdue open tickets found in this scope.';
    const labels = tasks.slice(0, 6).map((task) => {
      const due = task.dueAt ? new Date(task.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'no due date';
      return (task.title ?? 'Untitled ticket') + ' (' + (task.status ?? 'unknown') + ', due ' + due + ')';
    }).join('; ');
    return 'I found ' + tasks.length + ' overdue open ticket' + (tasks.length === 1 ? '' : 's') + ': ' + labels + (tasks.length > 6 ? '; and more.' : '.');
  }

  return null;
}

function buildToolFailureAnswer(toolResults: AssistantToolResult[]) {
  const failedResults = toolResults.filter((result) => !result.ok);
  if (failedResults.length === 0) return null;

  const failure = failedResults[0];
  const action = failure.toolName === 'create_task'
    ? 'create the ticket'
    : failure.toolName === 'update_task_status' || failure.toolName === 'update_task_priority' || failure.toolName === 'update_task_due_date'
      ? 'update the ticket'
      : failure.toolName === 'add_task_comment'
        ? 'add the comment'
        : 'run that request';

  return "I couldn't " + action + ': ' + String(failure.result);
}

function buildFallbackAnswer(chunks: RetrievalChunk[], toolResults: AssistantToolResult[] = []) {
  if (toolResults.length > 0) {
    return 'I ran the requested Tixora tool. Result: ' + JSON.stringify(toolResults.map((result) => result.result));
  }

  if (chunks.length === 0) return "I don't have enough information.";

  const taskTitles = [...new Set(chunks.map((chunk) => chunk.taskTitle))].slice(0, 3);
  return (
    'I found related Tixora items, but the AI answer model is not configured yet. Relevant tasks: ' +
    taskTitles.join(', ')
  );
}

export async function askAssistant(params: {
  userId: string;
  userDisplayName: string;
  orgSlug?: string;
  input: AskAssistantInput;
}) {
  const scope = await resolveAssistantScope({
    userId: params.userId,
    orgSlug: params.orgSlug,
    projectId: params.input.projectId
  });

  if (!scope) {
    throw new HttpError(404, 'Assistant scope not found', 'ASSISTANT_SCOPE_NOT_FOUND');
  }

  const deterministicReadCall = buildDeterministicReadToolCall(params.input.query, params.input.projectId);
  if (deterministicReadCall) {
    const toolResults = [await executeAssistantToolCall({
      call: deterministicReadCall,
      userId: params.userId,
      userDisplayName: params.userDisplayName,
      orgId: scope.orgId
    })];

    return {
      answer: buildToolFailureAnswer(toolResults) ?? buildToolSuccessAnswer(toolResults) ?? buildFallbackAnswer([], toolResults),
      toolResults,
      pendingActions: [],
      sources: []
    };
  }

  if (isTaskCountQuestion(params.input.query)) {
    const counts = await countAccessibleTasks({
      userId: params.userId,
      orgId: scope.orgId,
      projectId: params.input.projectId
    });

    return {
      answer: buildTaskCountAnswer(counts, Boolean(params.input.projectId)),
      toolResults: [],
      pendingActions: [],
      sources: []
    };
  }

  let chunks: RetrievalChunk[] = [];
  
  try {
    chunks = await retrieveRelevantChunks({
      query: params.input.query,
      userId: params.userId,
      orgId: scope.orgId,
      projectId: params.input.projectId,
      limit: 8
    });
  } catch (error) {
    throw toAssistantHttpError(error, 'Assistant retrieval failed');
  }

  const context = [
    getCurrentDateContext(),
    params.input.projectId ? 'Current project ID: ' + params.input.projectId : '',
    buildContext(chunks)
  ].filter(Boolean).join('\n\n');
  let selectedToolCalls = [];

  try {
    selectedToolCalls = await selectAssistantToolCalls({
      query: params.input.query,
      context,
      tools: assistantToolDefinitions
    });
  } catch (error) {
    throw toAssistantHttpError(error, 'Assistant tool selection failed');
  }
  const toolCalls = selectedToolCalls.reduce<AssistantToolCall[]>((current, call) => {
    if (!isAssistantToolName(call.name)) return current;

    return [
      ...current,
      {
        ...withDefaultProjectId({
          id: call.id,
          name: call.name,
          argumentsText: call.argumentsText
        }, params.input.projectId)
      }
    ];
  }, []);

  const mutatingToolCalls = toolCalls.filter((call) => isMutatingAssistantTool(call.name));
  const nonMutatingToolCalls = toolCalls.filter((call) => !isMutatingAssistantTool(call.name));

  const pendingActions = mutatingToolCalls.map((call) => buildPendingAssistantAction(call));
  storePendingActions({ userId: params.userId, orgId: scope.orgId, actions: pendingActions });

  const toolResults = await Promise.all(
    nonMutatingToolCalls.map((call) =>
      executeAssistantToolCall({
        call,
        userId: params.userId,
        userDisplayName: params.userDisplayName,
        orgId: scope.orgId
      })
    )
  );

  if (pendingActions.length > 0) {
    return {
      answer: pendingActions.length === 1 ? 'Review and confirm this action before I run it.' : 'Review and confirm these actions before I run them.',
      toolResults,
      pendingActions,
      sources: emptySources()
    };
  }

  const toolFailureAnswer = buildToolFailureAnswer(toolResults);
  if (toolFailureAnswer) {
    return {
      answer: toolFailureAnswer,
      toolResults,
      pendingActions: [],
      sources: []
    };
  }

  const toolSuccessAnswer = buildToolSuccessAnswer(toolResults);
  if (toolSuccessAnswer) {
    return {
      answer: toolSuccessAnswer,
      toolResults,
      pendingActions: [],
      sources: []
    };
  }

  const toolContext = buildToolContext(toolResults);
  let answer: string | null = null;

  try {
    answer = await generateGroundedAnswer({
      query: params.input.query,
      context: [context, toolContext].filter(Boolean).join('\n\n')
    });
  } catch (error) {
    throw toAssistantHttpError(error, 'Assistant answer generation failed');
  }

  return {
    answer: answer ?? buildFallbackAnswer(chunks, toolResults),
    toolResults,
    pendingActions: [],
    sources: []
  };
}


export async function confirmAssistantActions(params: {
  userId: string;
  userDisplayName: string;
  orgSlug?: string;
  input: ConfirmAssistantActionsInput;
}) {
  const scope = await resolveAssistantScope({
    userId: params.userId,
    orgSlug: params.orgSlug
  });

  if (!scope) {
    throw new HttpError(404, 'Assistant scope not found', 'ASSISTANT_SCOPE_NOT_FOUND');
  }

  const confirmedIds = new Set(params.input.confirmedIds);
  const toolResults: AssistantToolResult[] = [];

  for (const pendingAction of params.input.pendingActions) {
    if (!isAssistantToolName(pendingAction.toolName)) {
      toolResults.push({
        toolCallId: pendingAction.id,
        toolName: pendingAction.toolName as ToolName,
        ok: false,
        result: 'Unknown tool'
      });
      continue;
    }

    const replayError = takePendingAction({
      id: pendingAction.id,
      userId: params.userId,
      orgId: scope.orgId,
      toolName: pendingAction.toolName
    });

    if (replayError) {
      toolResults.push({
        toolCallId: pendingAction.id,
        toolName: pendingAction.toolName,
        ok: false,
        result: replayError
      });
      continue;
    }

    if (!confirmedIds.has(pendingAction.id)) continue;

    if (!isMutatingAssistantTool(pendingAction.toolName)) {
      toolResults.push({
        toolCallId: pendingAction.id,
        toolName: pendingAction.toolName,
        ok: false,
        result: 'Only pending write actions can be confirmed'
      });
      continue;
    }

    try {
      validateAssistantToolCall({
        id: pendingAction.id,
        name: pendingAction.toolName,
        argumentsText: pendingAction.argumentsText
      });

      const result = await executeAssistantToolCall({
        call: {
          id: pendingAction.id,
          name: pendingAction.toolName,
          argumentsText: pendingAction.argumentsText
        },
        userId: params.userId,
        userDisplayName: params.userDisplayName,
        orgId: scope.orgId
      });

      if (result.ok) {
        await logAssistantActionEvent({
          userId: params.userId,
          toolName: pendingAction.toolName,
          result: result.result
        });
      }

      toolResults.push(result);
    } catch (error) {
      toolResults.push({
        toolCallId: pendingAction.id,
        toolName: pendingAction.toolName,
        ok: false,
        result: error instanceof Error ? error.message : 'Tool execution failed'
      });
    }
  }

  const toolFailureAnswer = buildToolFailureAnswer(toolResults);
  const toolSuccessAnswer = buildToolSuccessAnswer(toolResults);

  return {
    answer: toolFailureAnswer ?? toolSuccessAnswer ?? 'No confirmed actions were executed.',
    toolResults
  };
}
