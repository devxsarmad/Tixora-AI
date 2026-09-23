// Usage:
// Task business rules: convert repository outcomes into stable HTTP errors and
// normalize assignment input before SQL sees it.

import { enqueueTaskEmbedding } from '../assistant/embedding.service.js';
import { HttpError } from '../../shared/http-error.js';
import { dispatchEvent } from '../../utils/webhookDispatcher.js';
import {
  createTaskForProject,
  findTaskDetailForUser,
  listTasksForProject,
  replaceTaskAssigneesForUser,
  updateTaskForUser
} from './task.repository.js';
import type {
  CreateTaskInput,
  ListTasksQuery,
  ReplaceTaskAssigneesInput,
  UpdateTaskInput
} from './task.schemas.js';

function uniqueIds(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])];
}

function dispatchNewAssignments(params: {
  taskId: string;
  taskTitle: string;
  projectId: string;
  assignedBy: string;
  assignedByName: string;
  previousAssigneeIds: string[];
  assignees: Array<{ id: string; displayName: string }>;
}): void {
  const previousAssigneeIds = new Set(params.previousAssigneeIds);

  for (const assignee of params.assignees) {
    if (previousAssigneeIds.has(assignee.id)) continue;

    dispatchEvent('task.assigned', {
      taskId: params.taskId,
      taskTitle: params.taskTitle,
      assigneeId: assignee.id,
      assigneeName: assignee.displayName,
      assignedBy: params.assignedBy,
      assignedByName: params.assignedByName,
      projectId: params.projectId
    });
  }
}

function isInvalidAssigneeResult(
  result: unknown
): result is { invalidAssigneeIds: string[] } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'invalidAssigneeIds' in result
  );
}

function handleTaskWriteResult<T>(
  result: T | null | 'forbidden' | { invalidAssigneeIds: string[] }
): T {
  if (result === 'forbidden') {
    throw new HttpError(403, 'Task permission denied', 'TASK_FORBIDDEN');
  }

  if (!result) {
    throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
  }

  if (isInvalidAssigneeResult(result)) {
    throw new HttpError(
      400,
      'All assignees must be project members',
      'INVALID_TASK_ASSIGNEES'
    );
  }

  return result;
}

export async function createTask(params: {
  projectId: string;
  userId: string;
  input: CreateTaskInput;
}) {
  const result = await createTaskForProject({
    projectId: params.projectId,
    userId: params.userId,
    title: params.input.title,
    description: params.input.description,
    status: params.input.status,
    priority: params.input.priority,
    dueAt: params.input.dueAt,
    assigneeIds: uniqueIds(params.input.assigneeIds)
  });

  if (!result) {
    throw new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND');
  }

  const task = handleTaskWriteResult(result);
  enqueueTaskEmbedding(task.id);
  return task;
}

export async function listProjectTasks(params: {
  projectId: string;
  userId: string;
  query: ListTasksQuery;
}) {
  const tasks = await listTasksForProject({
    projectId: params.projectId,
    userId: params.userId,
    status: params.query.status,
    priority: params.query.priority,
    assigneeId: params.query.assigneeId,
    due: params.query.due
  });

  if (!tasks) {
    throw new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND');
  }

  return tasks;
}

export async function getTask(params: { taskId: string; userId: string }) {
  const task = await findTaskDetailForUser(params);

  if (!task) {
    throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
  }

  return task;
}

export async function updateTask(params: {
  taskId: string;
  userId: string;
  userDisplayName: string;
  input: UpdateTaskInput;
}) {
  const tracksStatusChange = params.input.status !== undefined;
  const tracksAssignmentChange = params.input.assigneeIds !== undefined;
  const previousTask = tracksStatusChange || tracksAssignmentChange
    ? await findTaskDetailForUser({
        taskId: params.taskId,
        userId: params.userId
      })
    : null;

  const result = await updateTaskForUser({
    taskId: params.taskId,
    userId: params.userId,
    title: params.input.title,
    description: params.input.description,
    status: params.input.status,
    priority: params.input.priority,
    dueAt: params.input.dueAt,
    assigneeIds: params.input.assigneeIds === undefined ? undefined : uniqueIds(params.input.assigneeIds)
  });

  const task = handleTaskWriteResult(result);

  if (tracksStatusChange && previousTask && previousTask.status !== task.status) {
    dispatchEvent('task.status_changed', {
      taskId: task.id,
      taskTitle: task.title,
      oldStatus: previousTask.status,
      newStatus: task.status,
      projectId: task.projectId,
      updatedBy: params.userId,
      updatedByName: params.userDisplayName
    });
  }

  if (tracksAssignmentChange && previousTask) {
    dispatchNewAssignments({
      taskId: task.id,
      taskTitle: task.title,
      projectId: task.projectId,
      assignedBy: params.userId,
      assignedByName: params.userDisplayName,
      previousAssigneeIds: previousTask.assignees.map((assignee) => assignee.id),
      assignees: task.assignees
    });
  }

  enqueueTaskEmbedding(task.id);
  return task;
}

export async function replaceTaskAssignees(params: {
  taskId: string;
  userId: string;
  userDisplayName: string;
  input: ReplaceTaskAssigneesInput;
}) {
  const previousTask = await findTaskDetailForUser({
    taskId: params.taskId,
    userId: params.userId
  });

  const result = await replaceTaskAssigneesForUser({
    taskId: params.taskId,
    userId: params.userId,
    assigneeIds: uniqueIds(params.input.assigneeIds)
  });

  const task = handleTaskWriteResult(result);

  if (previousTask) {
    dispatchNewAssignments({
      taskId: task.id,
      taskTitle: task.title,
      projectId: task.projectId,
      assignedBy: params.userId,
      assignedByName: params.userDisplayName,
      previousAssigneeIds: previousTask.assignees.map((assignee) => assignee.id),
      assignees: task.assignees
    });
  }

  return task;
}
