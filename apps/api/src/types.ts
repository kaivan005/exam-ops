import type { Role } from '@prisma/client';

declare module 'express-session' {
  interface SessionData { userId?: string; role?: Role; }
}

export type AuthUser = { id: string; email: string; name: string; role: Role; departmentId: string | null };
