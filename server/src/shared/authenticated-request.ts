// Usage:
// Defines the request shape after JWT authentication middleware has attached
// the current user.

import type { Request } from 'express';

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
};

export type AuthenticatedRequest = Request & {
  user: AuthenticatedUser;
};
