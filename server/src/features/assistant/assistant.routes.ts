import { Router } from 'express';
import { requireAuth } from '../../middleware/require-auth.js';
import { asyncHandler } from '../../shared/async-handler.js';
import type { AuthenticatedRequest } from '../../shared/authenticated-request.js';
import { askAssistantSchema, confirmAssistantActionsSchema } from './assistant.schemas.js';
import { askAssistant, confirmAssistantActions } from './assistant.service.js';

export const assistantRouter = Router();

assistantRouter.post(
  '/assistant/ask',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const input = askAssistantSchema.parse(req.body);
    const orgSlugHeader = req.header('x-tixora-org-slug')?.trim();

    const result = await askAssistant({
      userId: authReq.user.id,
      userDisplayName: authReq.user.displayName,
      orgSlug: orgSlugHeader || undefined,
      input
    });

    res.status(200).json(result);
  })
);

assistantRouter.post(
  '/assistant/confirm',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const input = confirmAssistantActionsSchema.parse(req.body);
    const orgSlugHeader = req.header('x-tixora-org-slug')?.trim();

    const result = await confirmAssistantActions({
      userId: authReq.user.id,
      userDisplayName: authReq.user.displayName,
      orgSlug: orgSlugHeader || undefined,
      input
    });

    res.status(200).json(result);
  })
);
