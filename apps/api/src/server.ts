import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import argon2 from 'argon2';
import { z } from 'zod';
import { Pool } from 'pg';
import { prisma } from './prisma';
import { asyncRoute, requireAuth, requireRole } from './middleware';
import type { Role } from '@prisma/client';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PgStore = connectPgSimple(session);
app.set('trust proxy', isProduction ? 1 : 0);
app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(session({ store: new PgStore({ pool, createTableIfMissing: true }), secret: process.env.SESSION_SECRET ?? 'dev-only-change-me', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 1000 * 60 * 60 * 8 } }));
app.use(express.static(path.resolve(__dirname, '../../web/dist')));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8).max(128) });

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'examops-api' }));
app.post('/api/v1/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email and password' } });
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  if (!user || !user.isActive || !(await argon2.verify(user.passwordHash, parsed.data.password))) return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
  await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.userId = user.id; req.session.role = user.role;
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, departmentId: user.departmentId } });
}));
app.post('/api/v1/auth/logout', requireAuth, asyncRoute(async (req, res) => { await new Promise<void>((resolve, reject) => req.session.destroy(err => err ? reject(err) : resolve())); res.clearCookie('connect.sid'); res.status(204).send(); }));
app.get('/api/v1/auth/me', requireAuth, (_req, res) => { const user = res.locals.user; res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, departmentId: user.departmentId } }); });

app.get('/api/v1/dashboard', requireAuth, asyncRoute(async (_req, res) => {
  const user = res.locals.user;
  const departmentFilter = user.role === 'HOD' && user.departmentId ? { departmentId: user.departmentId } : {};
  const [schedules, issues, rooms, notifications] = await Promise.all([
    prisma.examinationSchedule.findMany({ where: { ...departmentFilter, status: { not: 'CANCELLED' } }, include: { subject: true, roomAllocations: { include: { room: true, seats: true } } }, orderBy: { startsAt: 'asc' }, take: 10 }),
    prisma.issueReport.count({ where: user.role === 'STUDENT' || user.role === 'INVIGILATOR' ? { creatorId: user.id, status: { not: 'RESOLVED' } } : { status: { not: 'RESOLVED' } } }),
    prisma.examinationRoom.count(),
    prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 5 })
  ]);
  res.json({ stats: { totalExams: schedules.length, upcoming: schedules.filter(s => s.startsAt > new Date()).length, unresolvedIssues: issues, rooms }, schedules, notifications });
}));

app.get('/api/v1/issues', requireAuth, asyncRoute(async (_req, res) => {
  const user = res.locals.user;
  const where = user.role === 'ADMIN' || user.role === 'HOD' ? {} : { creatorId: user.id };
  res.json(await prisma.issueReport.findMany({ where, orderBy: { createdAt: 'desc' }, include: { creator: { select: { name: true, email: true } } } }));
}));
app.post('/api/v1/issues', requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ title: z.string().min(3).max(120), description: z.string().min(5).max(2000), category: z.enum(['SCHEDULE','ROOM','ATTENDANCE','INCIDENT','OTHER']), priority: z.enum(['LOW','MEDIUM','HIGH','CRITICAL']).default('MEDIUM'), scheduleId: z.string().cuid().optional() });
  const result = schema.safeParse(req.body); if (!result.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Issue details are invalid' } });
  const issue = await prisma.issueReport.create({ data: { ...result.data, creatorId: res.locals.user.id } }); res.status(201).json(issue);
}));
app.patch('/api/v1/issues/:id', requireAuth, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const result = z.object({ status: z.enum(['OPEN','IN_PROGRESS','RESOLVED','REJECTED']), assigneeId: z.string().cuid().nullable().optional() }).safeParse(req.body); if (!result.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Issue update is invalid' } });
  const issueId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  res.json(await prisma.issueReport.update({ where: { id: issueId }, data: result.data }));
}));

app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html')) return res.sendFile(path.resolve(__dirname, '../../web/dist/index.html'));
  next();
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { console.error('request_error', err instanceof Error ? err.message : 'unknown'); res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } }); });

if (require.main === module) app.listen(Number(process.env.PORT ?? 4000), () => console.log(`ExamOps API listening on ${process.env.PORT ?? 4000}`));
export { app };
