// Usage:
// Verifies the HttpOnly cookie JWT, checks the user still exists and is active, then attaches
// the authenticated user to the request.

import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { HttpError } from '../shared/http-error.js';
import type { AuthenticatedUser } from '../shared/authenticated-request.js';
import { readAuthCookie } from '../features/auth/auth.cookie.js';

type JwtPayload = {
  sub?: string;
  email?: string;
};

type ActiveUserRow = {
  id: string;
  email: string;
  displayName: string;
};

async function findActiveUserById(userId: string): Promise<AuthenticatedUser | null> {
  const result = await query<ActiveUserRow>(
    `
      SELECT id, email, display_name AS "displayName"
      FROM users
      WHERE id = $1
        AND is_active = true
      LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] ?? null;
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = readAuthCookie(req.header('cookie'));
    if (!token) throw new HttpError(401, 'Authentication required', 'AUTH_REQUIRED');
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    if (!payload.sub) {
      throw new HttpError(401, 'Invalid access token', 'INVALID_TOKEN');
    }

    const user = await findActiveUserById(payload.sub);

    if (!user) {
      throw new HttpError(401, 'Invalid access token', 'INVALID_TOKEN');
    }

    (req as typeof req & { user: AuthenticatedUser }).user = user;
    next();
  } catch (error) {
    if (error instanceof HttpError) {
      next(error);
      return;
    }

    next(new HttpError(401, 'Invalid access token', 'INVALID_TOKEN'));
  }
};
