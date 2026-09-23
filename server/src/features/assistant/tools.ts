import { z } from 'zod';
import { query } from '../../db/pool.js';
import { createTask, listProjectTasks, updateTask } from '../tasks/task.service.js';
import { createComment } from '../comments/comment.service.js';
import type { TaskSummary } from '../tasks/task.repository.js';

const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
const taskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'done']);

const listOverdueTasksSchema = z.object({
  projectId: z.string().uuid().optional()
});

const listTasksToolSchema = z.object({
  projectId: z.string().uuid().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assigneeState: z.enum(['assigned', 'unassigned']).optional(),
  due: z.enum(['overdue', 'upcoming']).optional()
});

const summarizeAssigneeWorkloadSchema = z.object({
  userId: z.string().uuid().optional(),
  userRef: z.string().trim().min(1).optional(),
  projectId: z.string().uuid().optional()
});

const assigneeReferencesSchema: z.ZodType<string[], z.ZodTypeDef, unknown> = z.preprocess((value) => {
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return value;
}, z.array(z.string().trim().min(1)).min(1, 'Assign at least one project member.').max(20));

const createTaskToolSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).optional(),
  priority: taskPrioritySchema.optional(),
  dueAt: z.string().trim().min(1).nullable().optional(),
  assigneeIds: assigneeReferencesSchema
});

const taskReferenceSchema = {
  taskId: z.string().uuid().optional(),
  taskTitle: z.string().trim().min(1).optional(),
  projectId: z.string().uuid().optional()
};

const searchTasksSchema = z.object({
  query: z.string().trim().min(1).max(160),
  projectId: z.string().uuid().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional()
});

const updateTaskStatusSchema = z.object({
  ...taskReferenceSchema,
  status: taskStatusSchema
}).refine((value) => Boolean(value.taskId || value.taskTitle), {
  message: 'Provide a taskId or taskTitle',
  path: ['taskTitle']
});

const updateTaskPrioritySchema = z.object({
  ...taskReferenceSchema,
  priority: taskPrioritySchema
}).refine((value) => Boolean(value.taskId || value.taskTitle), {
  message: 'Provide a taskId or taskTitle',
  path: ['taskTitle']
});

const updateTaskDueDateSchema = z.object({
  ...taskReferenceSchema,
  dueAt: z.string().trim().min(1).nullable()
}).refine((value) => Boolean(value.taskId || value.taskTitle), {
  message: 'Provide a taskId or taskTitle',
  path: ['taskTitle']
});

const addTaskCommentSchema = z.object({
  ...taskReferenceSchema,
  body: z.string().trim().min(1).max(4000)
}).refine((value) => Boolean(value.taskId || value.taskTitle), {
  message: 'Provide a taskId or taskTitle',
  path: ['taskTitle']
});

export type ToolName =
  | 'list_overdue_tasks'
  | 'list_tasks'
  | 'summarize_assignee_workload'
  | 'search_tasks'
  | 'create_task'
  | 'update_task_status'
  | 'update_task_priority'
  | 'update_task_due_date'
  | 'add_task_comment';

export type AssistantToolCall = {
  id: string;
  name: ToolName;
  argumentsText: string;
};

export type AssistantToolResult = {
  toolCallId: string;
  toolName: ToolName;
  ok: boolean;
  result: unknown;
};

export type PendingAssistantAction = {
  id: string;
  toolName: ToolName;
  argumentsText: string;
  preview: {
    title: string;
    description: string;
    fields: Array<{
      label: string;
      value: string;
      editable: boolean;
      argumentKey: string;
    }>;
  };
};

type ToolTaskRow = {
  id: string;
  project_id: string;
  title: string;
  status: TaskSummary['status'];
  priority: TaskSummary['priority'];
  due_at: string | null;
  project_name: string;
  assignee_count: number;
};

type LookupUserRow = {
  user_id: string;
  email: string;
  display_name: string;
};

type LookupTaskRow = {
  id: string;
  title: string;
  project_name: string;
};

type WorkloadRow = {
  user_id: string;
  display_name: string;
  email: string;
  project_id: string;
  project_name: string;
  todo_count: number;
  in_progress_count: number;
  blocked_count: number;
  done_count: number;
  overdue_count: number;
};

export const assistantToolDefinitions = [
  {
    type: 'function',
    mutating: false,
    function: {
      name: 'list_overdue_tasks',
      description: 'List overdue tasks the requester can access, optionally scoped to a project.',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', format: 'uuid' } },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    mutating: false,
    function: {
      name: 'list_tasks',
      description: 'List accessible tickets by structured filters like status, priority, due date, or assigned/unassigned state. Use this for show/list/which ticket questions that do not need semantic text search.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          assigneeState: { type: 'string', enum: ['assigned', 'unassigned'] },
          due: { type: 'string', enum: ['overdue', 'upcoming'] }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    mutating: false,
    function: {
      name: 'summarize_assignee_workload',
      description: 'Summarize workload. If the user asks about each/every/all project member, call this with no userRef. If the user gives one name or email, pass it as userRef; do not invent a UUID.',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string', format: 'uuid' },
          userRef: { type: 'string', description: 'Exact member name or email from the user request.' },
          projectId: { type: 'string', format: 'uuid' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    mutating: false,
    function: {
      name: 'search_tasks',
      description: 'Search accessible tickets by title or description, optionally scoped to a project/status/priority.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    mutating: true,
    function: {
      name: 'create_task',
      description: 'Create a task in a project. A task must have at least one assignee. If assignees are named by the user, pass names/emails in assigneeIds so the server resolves them against project members.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          dueAt: { type: ['string', 'null'], description: 'Due date as ISO date-time when possible.' },
          assigneeIds: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Project member UUIDs, names, or emails.' }
        },
        required: ['projectId', 'title', 'assigneeIds'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    mutating: true,
    function: {
      name: 'update_task_status',
      description: 'Update a task status. If the user gives a ticket title, pass taskTitle; do not require a UUID.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          taskTitle: { type: 'string', description: 'Exact or near-exact ticket title from the user request.' },
          projectId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] }
        },
        required: ['status'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    mutating: true,
    function: {
      name: 'update_task_priority',
      description: 'Update a ticket priority. If the user gives a ticket title, pass taskTitle; do not require a UUID.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          taskTitle: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] }
        },
        required: ['priority'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    mutating: true,
    function: {
      name: 'update_task_due_date',
      description: 'Update a ticket due date. If the user gives a ticket title, pass taskTitle; do not require a UUID.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          taskTitle: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
          dueAt: { type: ['string', 'null'], description: 'Due date as ISO date-time when possible.' }
        },
        required: ['dueAt'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    mutating: true,
    function: {
      name: 'add_task_comment',
      description: 'Add a comment to a ticket. If the user gives a ticket title, pass taskTitle; do not require a UUID.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          taskTitle: { type: 'string' },
          projectId: { type: 'string', format: 'uuid' },
          body: { type: 'string' }
        },
        required: ['body'],
        additionalProperties: false
      }
    }
  }
] as const;

const mutatingToolNames = new Set<ToolName>([
  'create_task',
  'update_task_status',
  'update_task_priority',
  'update_task_due_date',
  'add_task_comment'
]);

function schemaForTool(toolName: ToolName) {
  if (toolName === 'list_overdue_tasks') return listOverdueTasksSchema;
  if (toolName === 'list_tasks') return listTasksToolSchema;
  if (toolName === 'summarize_assignee_workload') return summarizeAssigneeWorkloadSchema;
  if (toolName === 'search_tasks') return searchTasksSchema;
  if (toolName === 'create_task') return createTaskToolSchema;
  if (toolName === 'update_task_status') return updateTaskStatusSchema;
  if (toolName === 'update_task_priority') return updateTaskPrioritySchema;
  if (toolName === 'update_task_due_date') return updateTaskDueDateSchema;
  if (toolName === 'add_task_comment') return addTaskCommentSchema;
  return null;
}

export function isMutatingAssistantTool(toolName: ToolName) {
  return mutatingToolNames.has(toolName);
}

export function validateAssistantToolCall(call: AssistantToolCall) {
  const schema = schemaForTool(call.name);
  if (!schema) throw new Error('Unknown tool');
  return parseToolArguments(call.argumentsText, schema);
}

function humanizeStatus(status: string | undefined) {
  if (!status) return '';
  return status.replace(/_/g, ' ');
}

function stringifyPreviewValue(value: unknown) {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined) return '';
  return String(value);
}

export function buildPendingAssistantAction(call: AssistantToolCall): PendingAssistantAction {
  const args = validateAssistantToolCall(call) as Record<string, unknown>;
  const id = call.id;

  if (call.name === 'create_task') {
    const title = stringifyPreviewValue(args.title);
    const priority = stringifyPreviewValue(args.priority || 'medium');
    return {
      id,
      toolName: call.name,
      argumentsText: call.argumentsText,
      preview: {
        title: 'Create ticket',
        description: 'Create "' + title + '" with ' + priority + ' priority.',
        fields: [
          { label: 'Project ID', value: stringifyPreviewValue(args.projectId), editable: true, argumentKey: 'projectId' },
          { label: 'Task title', value: title, editable: true, argumentKey: 'title' },
          { label: 'Description', value: stringifyPreviewValue(args.description), editable: true, argumentKey: 'description' },
          { label: 'Priority', value: priority, editable: true, argumentKey: 'priority' },
          { label: 'Due date', value: stringifyPreviewValue(args.dueAt), editable: true, argumentKey: 'dueAt' },
          { label: 'Assignees', value: stringifyPreviewValue(args.assigneeIds), editable: true, argumentKey: 'assigneeIds' }
        ]
      }
    };
  }

  if (call.name === 'update_task_status') {
    const taskLabel = stringifyPreviewValue(args.taskTitle || args.taskId);
    const status = stringifyPreviewValue(args.status);
    return {
      id,
      toolName: call.name,
      argumentsText: call.argumentsText,
      preview: {
        title: 'Update ticket status',
        description: 'Move "' + taskLabel + '" to ' + humanizeStatus(status) + '.',
        fields: [
          { label: 'Ticket', value: taskLabel, editable: true, argumentKey: args.taskTitle ? 'taskTitle' : 'taskId' },
          { label: 'Project ID', value: stringifyPreviewValue(args.projectId), editable: true, argumentKey: 'projectId' },
          { label: 'Status', value: status, editable: true, argumentKey: 'status' }
        ]
      }
    };
  }

  return {
    id,
    toolName: call.name,
    argumentsText: call.argumentsText,
    preview: {
      title: 'Confirm action',
      description: 'Review this assistant action before it runs.',
      fields: Object.entries(args).map(([key, value]) => ({
        label: key,
        value: stringifyPreviewValue(value),
        editable: true,
        argumentKey: key
      }))
    }
  };
}

export async function logAssistantActionEvent(params: { userId: string; toolName: ToolName; result: unknown }) {
  if (typeof params.result !== 'object' || params.result === null || !('id' in params.result)) return;
  const taskId = (params.result as { id?: unknown }).id;
  if (typeof taskId !== 'string') return;

  await query(
    `
      INSERT INTO task_events (task_id, actor_id, actor_type, field, old_value, new_value)
      VALUES ($1, $2, 'ai_assistant', 'ai_assistant', NULL, $3)
    `,
    [taskId, params.userId, params.toolName]
  );
}

function friendlyArgumentName(path: PropertyKey[]) {
  const key = String(path[0] ?? 'field');
  const labels: Record<string, string> = {
    projectId: 'Project',
    taskId: 'Ticket',
    taskTitle: 'Ticket title',
    assigneeIds: 'Assignees',
    userId: 'Member',
    userRef: 'Member',
    dueAt: 'Due date'
  };
  return labels[key] ?? key;
}

function formatZodIssues(error: z.ZodError) {
  return error.issues
    .map((issue) => friendlyArgumentName(issue.path) + ': ' + issue.message)
    .join('; ');
}

function parseToolArguments<T>(argumentsText: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = argumentsText ? JSON.parse(argumentsText) : {};
  } catch {
    throw new Error('Tool arguments must be valid JSON');
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Invalid tool arguments: ' + formatZodIssues(result.error));
  }

  return result.data;
}

function normalizeLookupValue(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isUuid(value: string) {
  return z.string().uuid().safeParse(value).success;
}

function resolveOneByReference<T extends { email: string; display_name: string }>(rows: T[], reference: string, label: string) {
  const normalizedReference = normalizeLookupValue(reference);
  const exactMatches = rows.filter(
    (row) =>
      normalizeLookupValue(row.display_name) === normalizedReference ||
      normalizeLookupValue(row.email) === normalizedReference
  );
  const matches = exactMatches.length > 0
    ? exactMatches
    : rows.filter(
        (row) =>
          normalizeLookupValue(row.display_name).includes(normalizedReference) ||
          normalizeLookupValue(row.email).includes(normalizedReference)
      );

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error('Multiple ' + label + ' matched "' + reference + '". Use an exact email.');
  }

  throw new Error('Could not find ' + label + ': ' + reference + '.');
}

async function resolveProjectAssigneeReferences(projectId: string, references: string[] | undefined) {
  const uniqueRefs = [...new Set(references ?? [])].map((reference) => reference.trim()).filter(Boolean);
  if (uniqueRefs.length === 0) return [];

  const result = await query<LookupUserRow>(
    `
      SELECT
        users.id AS user_id,
        users.email,
        users.display_name
      FROM project_members
      JOIN users
        ON users.id = project_members.user_id
      WHERE project_members.project_id = $1
    `,
    [projectId]
  );

  const resolvedIds: string[] = [];

  for (const reference of uniqueRefs) {
    if (isUuid(reference)) {
      resolvedIds.push(reference);
      continue;
    }

    try {
      resolvedIds.push(resolveOneByReference(result.rows, reference, 'project member').user_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not resolve project member.';
      throw new Error(message + ' Add the person to Project members first or use an exact member email.');
    }
  }

  return [...new Set(resolvedIds)];
}

async function resolveWorkloadUserId(params: { orgId: string; userId?: string; userRef?: string; projectId?: string }) {
  if (params.userId) return params.userId;
  if (!params.userRef) throw new Error('Choose a member by name or email.');

  const result = await query<LookupUserRow>(
    `
      SELECT DISTINCT
        users.id AS user_id,
        users.email,
        users.display_name
      FROM team_members AS tm
      JOIN users
        ON users.id = tm.user_id
      LEFT JOIN project_members AS pm
        ON pm.user_id = users.id
       AND pm.project_id = $2
      LEFT JOIN task_assignees AS ta
        ON ta.user_id = users.id
      LEFT JOIN tasks AS assigned_task
        ON assigned_task.id = ta.task_id
       AND assigned_task.project_id = $2
       AND assigned_task.deleted_at IS NULL
      WHERE tm.team_id = $1
        AND ($2::uuid IS NULL OR pm.user_id IS NOT NULL OR assigned_task.id IS NOT NULL OR tm.role IN ('owner', 'admin'))
    `,
    [params.orgId, params.projectId ?? null]
  );

  return resolveOneByReference(result.rows, params.userRef, 'organization member').user_id;
}

async function findAccessibleTaskByTitle(params: { userId: string; orgId: string; projectId?: string; taskTitle: string }) {
  const queryTasks = async (exactOnly: boolean) => query<LookupTaskRow>(
    `
      SELECT
        task.id,
        task.title,
        p.name AS project_name
      FROM tasks AS task
      JOIN projects AS p
        ON p.id = task.project_id
      JOIN team_members AS tm
        ON tm.team_id = p.team_id
       AND tm.user_id = $2
      LEFT JOIN project_members AS pm
        ON pm.project_id = p.id
       AND pm.user_id = $2
      WHERE p.team_id = $1
        AND ($3::uuid IS NULL OR p.id = $3)
        AND p.deleted_at IS NULL
        AND task.deleted_at IS NULL
        AND (tm.role IN ('owner', 'admin') OR pm.user_id IS NOT NULL)
        AND (
          ($5::boolean = true AND lower(task.title) = lower($4)) OR
          ($5::boolean = false AND lower(task.title) LIKE '%' || lower($4) || '%')
        )
      ORDER BY task.updated_at DESC
      LIMIT 10
    `,
    [params.orgId, params.userId, params.projectId ?? null, params.taskTitle, exactOnly]
  );

  const exactMatches = await queryTasks(true);
  const matches = exactMatches.rows.length > 0 ? exactMatches.rows : (await queryTasks(false)).rows;

  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    const labels = matches.map((task) => '"' + task.title + '" in ' + task.project_name).join(', ');
    throw new Error('Multiple tickets matched "' + params.taskTitle + '": ' + labels + '. Use the exact ticket title.');
  }

  throw new Error('Could not find an accessible ticket named "' + params.taskTitle + '".');
}

function localDateAtEndOfDay(year: number, monthIndex: number, day: number) {
  return new Date(year, monthIndex, day, 17, 0, 0, 0).toISOString();
}

function parseRelativeDueAt(value: string) {
  const normalized = value.toLowerCase().replace(/[,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0, 0, 0);

  if (normalized === 'today' || normalized === 'tonight') return today.toISOString();
  if (normalized === 'tomorrow' || normalized === 'tmrw' || normalized === 'next day') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString();
  }

  const inDaysMatch = normalized.match(/(?:in|after)\s+(\d+)\s+days?/);
  if (inDaysMatch) {
    const due = new Date(today);
    due.setDate(due.getDate() + Number(inDaysMatch[1]));
    return due.toISOString();
  }

  if (normalized === 'next week') {
    const due = new Date(today);
    due.setDate(due.getDate() + 7);
    return due.toISOString();
  }

  const monthNames = new Map([
    ['jan', 0], ['january', 0], ['feb', 1], ['february', 1], ['mar', 2], ['march', 2],
    ['apr', 3], ['april', 3], ['may', 4], ['jun', 5], ['june', 5], ['jul', 6], ['july', 6],
    ['aug', 7], ['august', 7], ['sep', 8], ['sept', 8], ['september', 8], ['oct', 9], ['october', 9],
    ['nov', 10], ['november', 10], ['dec', 11], ['december', 11]
  ]);
  const monthMatch = normalized.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s*(\d{4})?/);
  if (monthMatch) {
    const day = Number(monthMatch[1]);
    const month = monthNames.get(monthMatch[2]);
    const year = monthMatch[3] ? Number(monthMatch[3]) : now.getFullYear();
    if (month !== undefined && day >= 1 && day <= 31) return localDateAtEndOfDay(year, month, day);
  }

  return null;
}

function normalizeDueAt(value: string | null | undefined) {
  if (value === undefined || value === null || value.trim() === '') return value ?? null;
  const relativeDueAt = parseRelativeDueAt(value);
  if (relativeDueAt) return relativeDueAt;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Could not understand due date "' + value + '". Use a clear date like 2026-08-31 or tomorrow.');
  }

  const looksDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  if (looksDateOnly) {
    return localDateAtEndOfDay(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
  }

  return parsed.toISOString();
}

function formatTask(task: TaskSummary) {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt,
    assignees: task.assignees.map((assignee) => ({ id: assignee.id, name: assignee.displayName, email: assignee.email }))
  };
}

async function listFilteredTasks(params: {
  userId: string;
  orgId: string;
  projectId?: string;
  status?: TaskSummary['status'];
  priority?: TaskSummary['priority'];
  assigneeState?: 'assigned' | 'unassigned';
  due?: 'overdue' | 'upcoming';
}) {
  const result = await query<ToolTaskRow>(
    `
      SELECT
        task.id,
        task.project_id,
        task.title,
        task.status,
        task.priority,
        task.due_at,
        p.name AS project_name,
        COUNT(DISTINCT ta.user_id)::int AS assignee_count
      FROM tasks AS task
      JOIN projects AS p
        ON p.id = task.project_id
      JOIN team_members AS tm
        ON tm.team_id = p.team_id
       AND tm.user_id = $2
      LEFT JOIN project_members AS pm
        ON pm.project_id = p.id
       AND pm.user_id = $2
      LEFT JOIN task_assignees AS ta
        ON ta.task_id = task.id
      WHERE p.team_id = $1
        AND ($3::uuid IS NULL OR p.id = $3)
        AND ($4::task_status IS NULL OR task.status = $4)
        AND ($5::task_priority IS NULL OR task.priority = $5)
        AND ($6::text IS NULL OR ($6 = 'overdue' AND task.due_at < now() AND task.status <> 'done') OR ($6 = 'upcoming' AND task.due_at >= now()))
        AND p.deleted_at IS NULL
        AND task.deleted_at IS NULL
        AND (tm.role IN ('owner', 'admin') OR pm.user_id IS NOT NULL)
      GROUP BY task.id, p.name
      HAVING ($7::text IS NULL OR ($7 = 'unassigned' AND COUNT(DISTINCT ta.user_id) = 0) OR ($7 = 'assigned' AND COUNT(DISTINCT ta.user_id) > 0))
      ORDER BY task.updated_at DESC
      LIMIT 50
    `,
    [params.orgId, params.userId, params.projectId ?? null, params.status ?? null, params.priority ?? null, params.due ?? null, params.assigneeState ?? null]
  );

  return result.rows.map((task) => ({
    id: task.id,
    projectId: task.project_id,
    projectName: task.project_name,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueAt: task.due_at,
    assigneeCount: task.assignee_count
  }));
}

async function listOverdueTasks(params: { userId: string; orgId: string; projectId?: string }) {
  if (params.projectId) {
    const tasks = await listProjectTasks({
      projectId: params.projectId,
      userId: params.userId,
      query: { due: 'overdue' }
    });
    return tasks.map(formatTask);
  }

  const result = await query<ToolTaskRow>(
    `
      SELECT
        task.id,
        task.project_id,
        task.title,
        task.status,
        task.priority,
        task.due_at,
        p.name AS project_name,
        COUNT(DISTINCT ta.user_id)::int AS assignee_count
      FROM tasks AS task
      JOIN projects AS p
        ON p.id = task.project_id
      JOIN team_members AS tm
        ON tm.team_id = p.team_id
       AND tm.user_id = $2
      LEFT JOIN project_members AS pm
        ON pm.project_id = p.id
       AND pm.user_id = $2
      LEFT JOIN task_assignees AS ta
        ON ta.task_id = task.id
      WHERE p.team_id = $1
        AND p.deleted_at IS NULL
        AND task.deleted_at IS NULL
        AND task.due_at < now()
        AND task.status <> 'done'
        AND (tm.role IN ('owner', 'admin') OR pm.user_id IS NOT NULL)
      GROUP BY task.id, p.name
      ORDER BY task.due_at ASC
      LIMIT 50
    `,
    [params.orgId, params.userId]
  );

  return result.rows.map((task) => ({
    id: task.id,
    projectId: task.project_id,
    projectName: task.project_name,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueAt: task.due_at,
    assigneeCount: task.assignee_count
  }));
}

function extractSearchTerms(queryText: string) {
  const stopWords = new Set(['find', 'show', 'search', 'ticket', 'tickets', 'task', 'tasks', 'related', 'to', 'or', 'and', 'the', 'a', 'an', 'bug', 'bugs']);
  const terms = queryText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !stopWords.has(term));

  return [...new Set(terms.length > 0 ? terms : [queryText.toLowerCase().trim()])];
}

async function searchTasks(params: {
  userId: string;
  orgId: string;
  queryText: string;
  projectId?: string;
  status?: TaskSummary['status'];
  priority?: TaskSummary['priority'];
}) {
  const searchTerms = extractSearchTerms(params.queryText);
  const result = await query<ToolTaskRow>(
    `
      SELECT
        task.id,
        task.project_id,
        task.title,
        task.status,
        task.priority,
        task.due_at,
        p.name AS project_name,
        COUNT(DISTINCT ta.user_id)::int AS assignee_count
      FROM tasks AS task
      JOIN projects AS p
        ON p.id = task.project_id
      JOIN team_members AS tm
        ON tm.team_id = p.team_id
       AND tm.user_id = $2
      LEFT JOIN project_members AS pm
        ON pm.project_id = p.id
       AND pm.user_id = $2
      LEFT JOIN task_assignees AS ta
        ON ta.task_id = task.id
      WHERE p.team_id = $1
        AND ($3::uuid IS NULL OR p.id = $3)
        AND ($5::task_status IS NULL OR task.status = $5)
        AND ($6::task_priority IS NULL OR task.priority = $6)
        AND p.deleted_at IS NULL
        AND task.deleted_at IS NULL
        AND (tm.role IN ('owner', 'admin') OR pm.user_id IS NOT NULL)
        AND (
          lower(task.title) LIKE '%' || lower($4) || '%' OR
          lower(coalesce(task.description, '')) LIKE '%' || lower($4) || '%' OR
          EXISTS (
            SELECT 1
            FROM unnest($7::text[]) AS search_term
            WHERE lower(task.title) LIKE '%' || search_term || '%'
               OR lower(coalesce(task.description, '')) LIKE '%' || search_term || '%'
          )
        )
      GROUP BY task.id, p.name
      ORDER BY task.updated_at DESC
      LIMIT 12
    `,
    [params.orgId, params.userId, params.projectId ?? null, params.queryText, params.status ?? null, params.priority ?? null, searchTerms]
  );

  return result.rows.map((task) => ({
    id: task.id,
    projectId: task.project_id,
    projectName: task.project_name,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueAt: task.due_at,
    assigneeCount: task.assignee_count
  }));
}

async function summarizeProjectMemberWorkloads(params: {
  userId: string;
  orgId: string;
  projectId?: string;
}) {
  const result = await query<WorkloadRow>(
    `
      SELECT
        assignee.id AS user_id,
        assignee.display_name,
        assignee.email,
        p.id AS project_id,
        p.name AS project_name,
        COUNT(task.id) FILTER (WHERE task.status = 'todo')::int AS todo_count,
        COUNT(task.id) FILTER (WHERE task.status = 'in_progress')::int AS in_progress_count,
        COUNT(task.id) FILTER (WHERE task.status = 'blocked')::int AS blocked_count,
        COUNT(task.id) FILTER (WHERE task.status = 'done')::int AS done_count,
        COUNT(task.id) FILTER (WHERE task.due_at < now() AND task.status <> 'done')::int AS overdue_count
      FROM project_members AS target_project
      JOIN users AS assignee
        ON assignee.id = target_project.user_id
      JOIN projects AS p
        ON p.id = target_project.project_id
      JOIN team_members AS requester_team
        ON requester_team.team_id = p.team_id
       AND requester_team.user_id = $2
      LEFT JOIN project_members AS requester_project
        ON requester_project.project_id = p.id
       AND requester_project.user_id = $2
      LEFT JOIN task_assignees AS ta
        ON ta.user_id = assignee.id
      LEFT JOIN tasks AS task
        ON task.id = ta.task_id
       AND task.project_id = p.id
       AND task.deleted_at IS NULL
      WHERE p.team_id = $1
        AND ($3::uuid IS NULL OR p.id = $3)
        AND p.deleted_at IS NULL
        AND (requester_team.role IN ('owner', 'admin') OR requester_project.user_id IS NOT NULL)
      GROUP BY assignee.id, assignee.display_name, assignee.email, p.id, p.name
      ORDER BY p.name ASC, assignee.display_name ASC
    `,
    [params.orgId, params.userId, params.projectId ?? null]
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    projectId: row.project_id,
    projectName: row.project_name,
    counts: {
      todo: row.todo_count,
      inProgress: row.in_progress_count,
      blocked: row.blocked_count,
      done: row.done_count,
      overdue: row.overdue_count
    }
  }));
}

async function summarizeAssigneeWorkload(params: {
  userId: string;
  orgId: string;
  targetUserId: string;
  projectId?: string;
}) {
  const result = await query<WorkloadRow>(
    `
      SELECT
        assignee.id AS user_id,
        assignee.display_name,
        assignee.email,
        p.id AS project_id,
        p.name AS project_name,
        COUNT(*) FILTER (WHERE task.status = 'todo')::int AS todo_count,
        COUNT(*) FILTER (WHERE task.status = 'in_progress')::int AS in_progress_count,
        COUNT(*) FILTER (WHERE task.status = 'blocked')::int AS blocked_count,
        COUNT(*) FILTER (WHERE task.status = 'done')::int AS done_count,
        COUNT(*) FILTER (WHERE task.due_at < now() AND task.status <> 'done')::int AS overdue_count
      FROM users AS assignee
      JOIN team_members AS target_team
        ON target_team.user_id = assignee.id
       AND target_team.team_id = $1
      JOIN task_assignees AS ta
        ON ta.user_id = assignee.id
      JOIN tasks AS task
        ON task.id = ta.task_id
      JOIN projects AS p
        ON p.id = task.project_id
      JOIN team_members AS requester_team
        ON requester_team.team_id = p.team_id
       AND requester_team.user_id = $2
      LEFT JOIN project_members AS requester_project
        ON requester_project.project_id = p.id
       AND requester_project.user_id = $2
      WHERE assignee.id = $3
        AND p.team_id = $1
        AND ($4::uuid IS NULL OR p.id = $4)
        AND p.deleted_at IS NULL
        AND task.deleted_at IS NULL
        AND (requester_team.role IN ('owner', 'admin') OR requester_project.user_id IS NOT NULL)
      GROUP BY assignee.id, assignee.display_name, assignee.email, p.id, p.name
      ORDER BY p.name ASC
    `,
    [params.orgId, params.userId, params.targetUserId, params.projectId ?? null]
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    projectId: row.project_id,
    projectName: row.project_name,
    counts: {
      todo: row.todo_count,
      inProgress: row.in_progress_count,
      blocked: row.blocked_count,
      done: row.done_count,
      overdue: row.overdue_count
    }
  }));
}

export async function executeAssistantToolCall(params: {
  call: AssistantToolCall;
  userId: string;
  userDisplayName: string;
  orgId: string;
}): Promise<AssistantToolResult> {
  try {
    if (params.call.name === 'list_overdue_tasks') {
      const args = parseToolArguments(params.call.argumentsText, listOverdueTasksSchema);
      return {
        toolCallId: params.call.id,
        toolName: params.call.name,
        ok: true,
        result: await listOverdueTasks({ userId: params.userId, orgId: params.orgId, projectId: args.projectId })
      };
    }

    if (params.call.name === 'list_tasks') {
      const args = parseToolArguments(params.call.argumentsText, listTasksToolSchema);
      return {
        toolCallId: params.call.id,
        toolName: params.call.name,
        ok: true,
        result: await listFilteredTasks({
          userId: params.userId,
          orgId: params.orgId,
          projectId: args.projectId,
          status: args.status,
          priority: args.priority,
          assigneeState: args.assigneeState,
          due: args.due
        })
      };
    }

    if (params.call.name === 'search_tasks') {
      const args = parseToolArguments(params.call.argumentsText, searchTasksSchema);
      return {
        toolCallId: params.call.id,
        toolName: params.call.name,
        ok: true,
        result: await searchTasks({
          userId: params.userId,
          orgId: params.orgId,
          queryText: args.query,
          projectId: args.projectId,
          status: args.status,
          priority: args.priority
        })
      };
    }

    if (params.call.name === 'summarize_assignee_workload') {
      const args = parseToolArguments(params.call.argumentsText, summarizeAssigneeWorkloadSchema);

      if (!args.userId && !args.userRef) {
        return {
          toolCallId: params.call.id,
          toolName: params.call.name,
          ok: true,
          result: await summarizeProjectMemberWorkloads({
            userId: params.userId,
            orgId: params.orgId,
            projectId: args.projectId
          })
        };
      }

      const targetUserId = await resolveWorkloadUserId({
        orgId: params.orgId,
        userId: args.userId,
        userRef: args.userRef,
        projectId: args.projectId
      });
      return {
        toolCallId: params.call.id,
        toolName: params.call.name,
        ok: true,
        result: await summarizeAssigneeWorkload({
          userId: params.userId,
          orgId: params.orgId,
          targetUserId,
          projectId: args.projectId
        })
      };
    }

    if (params.call.name === 'create_task') {
      const args = parseToolArguments(params.call.argumentsText, createTaskToolSchema);
      const assigneeIds = await resolveProjectAssigneeReferences(args.projectId, args.assigneeIds as string[]);
      const task = await createTask({
        projectId: args.projectId,
        userId: params.userId,
        input: {
          title: args.title,
          description: args.description,
          priority: args.priority,
          dueAt: normalizeDueAt(args.dueAt),
          assigneeIds
        }
      });
      return { toolCallId: params.call.id, toolName: params.call.name, ok: true, result: formatTask(task) };
    }

    if (params.call.name === 'update_task_status') {
      const args = parseToolArguments(params.call.argumentsText, updateTaskStatusSchema);
      const taskId = args.taskId ?? await findAccessibleTaskByTitle({
        userId: params.userId,
        orgId: params.orgId,
        projectId: args.projectId,
        taskTitle: args.taskTitle ?? ''
      });
      const task = await updateTask({
        taskId,
        userId: params.userId,
        userDisplayName: params.userDisplayName,
        input: { status: args.status }
      });
      return { toolCallId: params.call.id, toolName: params.call.name, ok: true, result: formatTask(task) };
    }

    if (params.call.name === 'update_task_priority') {
      const args = parseToolArguments(params.call.argumentsText, updateTaskPrioritySchema);
      const taskId = args.taskId ?? await findAccessibleTaskByTitle({
        userId: params.userId,
        orgId: params.orgId,
        projectId: args.projectId,
        taskTitle: args.taskTitle ?? ''
      });
      const task = await updateTask({
        taskId,
        userId: params.userId,
        userDisplayName: params.userDisplayName,
        input: { priority: args.priority }
      });
      return { toolCallId: params.call.id, toolName: params.call.name, ok: true, result: formatTask(task) };
    }

    if (params.call.name === 'update_task_due_date') {
      const args = parseToolArguments(params.call.argumentsText, updateTaskDueDateSchema);
      const taskId = args.taskId ?? await findAccessibleTaskByTitle({
        userId: params.userId,
        orgId: params.orgId,
        projectId: args.projectId,
        taskTitle: args.taskTitle ?? ''
      });
      const task = await updateTask({
        taskId,
        userId: params.userId,
        userDisplayName: params.userDisplayName,
        input: { dueAt: normalizeDueAt(args.dueAt) }
      });
      return { toolCallId: params.call.id, toolName: params.call.name, ok: true, result: formatTask(task) };
    }

    if (params.call.name === 'add_task_comment') {
      const args = parseToolArguments(params.call.argumentsText, addTaskCommentSchema);
      const taskId = args.taskId ?? await findAccessibleTaskByTitle({
        userId: params.userId,
        orgId: params.orgId,
        projectId: args.projectId,
        taskTitle: args.taskTitle ?? ''
      });
      const comment = await createComment({
        taskId,
        userId: params.userId,
        input: { body: args.body }
      });
      return { toolCallId: params.call.id, toolName: params.call.name, ok: true, result: comment };
    }

    return { toolCallId: params.call.id, toolName: params.call.name, ok: false, result: 'Unknown tool' };
  } catch (error) {
    return {
      toolCallId: params.call.id,
      toolName: params.call.name,
      ok: false,
      result: error instanceof Error ? error.message : 'Tool execution failed'
    };
  }
}
