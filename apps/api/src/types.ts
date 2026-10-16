import type { Role } from './db';

declare module 'express-session' {
  interface SessionData { userId?: string; role?: Role; }
}

export type AuthUser = { id: string; email: string; name: string; role: Role; departmentId: string | null };
