import type { NextFunction, Request, Response } from 'express';
import { getUserById, type Role } from './db';

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
  const user = await getUserById(req.session.userId);
  if (!user?.isActive) return res.status(401).json({ error: { code: 'SESSION_INVALID', message: 'Session is no longer valid' } });
  res.locals.user = user;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!roles.includes(res.locals.user?.role)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission for this action' } });
    next();
  };
}

export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req, res, next)).catch(next);
}
