// Usage:
// Task HTTP endpoints. Routes require JWT auth and delegate project/task access
// decisions to SQL-backed repository functions.

import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth.js';
import type { AuthenticatedRequest } from '../../shared/authenticated-request.js';
import { asyncHandler } from '../../shared/async-handler.js';
import {
  createTask,
  getTask,
  listProjectTasks,
  replaceTaskAssignees,
  updateTask
} from './task.service.js';
import {
  createTaskSchema,
  listTasksQuerySchema,
  projectIdParamSchema,
  replaceTaskAssigneesSchema,
  taskIdParamSchema,
  updateTaskSchema
} from './task.schemas.js';

export const taskRouter = Router();

taskRouter.post(
  '/projects/:projectId/tasks',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const params = projectIdParamSchema.parse(req.params);
    const input = createTaskSchema.parse(req.body);
    const task = await createTask({
      projectId: params.projectId,
      userId: authReq.user.id,
      input
    });

    res.status(201).json({ task });
  })
);

taskRouter.get(
  '/projects/:projectId/tasks',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const params = projectIdParamSchema.parse(req.params);
    const query = listTasksQuerySchema.parse(req.query);
    const tasks = await listProjectTasks({
      projectId: params.projectId,
      userId: authReq.user.id,
      query
    });

    res.status(200).json({ tasks });
  })
);

taskRouter.get(
  '/tasks/:taskId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const params = taskIdParamSchema.parse(req.params);
    const task = await getTask({
      taskId: params.taskId,
      userId: authReq.user.id
    });

    res.status(200).json({ task });
  })
);

taskRouter.patch(
  '/tasks/:taskId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const params = taskIdParamSchema.parse(req.params);
    const input = updateTaskSchema.parse(req.body);
    const task = await updateTask({
      taskId: params.taskId,
      userId: authReq.user.id,
      userDisplayName: authReq.user.displayName,
      input
    });

    res.status(200).json({ task });
  })
);

taskRouter.put(
  '/tasks/:taskId/assignees',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const params = taskIdParamSchema.parse(req.params);
    const input = replaceTaskAssigneesSchema.parse(req.body);
    const task = await replaceTaskAssignees({
      taskId: params.taskId,
      userId: authReq.user.id,
      userDisplayName: authReq.user.displayName,
      input
    });

    res.status(200).json({ task });
  })
);
