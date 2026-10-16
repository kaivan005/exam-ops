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
import { getDashboard, getUserByEmail, listIssues, createIssue, updateIssue, pool } from './db';
import { approveDisruption, applyAlternative, createDisruption, getAlternatives, listDisruptions, listRisks, recommendAlternatives, saveReview } from './adaptive';
import { asyncRoute, requireAuth, requireRole } from './middleware';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const PgStore = connectPgSimple(session);
app.set('trust proxy', isProduction ? 1 : 0);
app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(session({ store: new PgStore({ pool, createTableIfMissing: true }), secret: process.env.SESSION_SECRET ?? 'dev-only-change-me', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: process.env.SESSION_COOKIE_SAMESITE === 'none' ? 'none' : 'lax', secure: isProduction, maxAge: 1000 * 60 * 60 * 8 } }));
app.use(express.static(path.resolve(__dirname, '../../web/dist')));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8).max(128) });

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'examops-api' }));
app.post('/api/v1/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email and password' } });
  const user = await getUserByEmail(parsed.data.email);
  if (!user || !user.isActive || !(await argon2.verify(user.passwordHash, parsed.data.password))) return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
  await new Promise<void>((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.userId = user.id; req.session.role = user.role;
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, departmentId: user.departmentId } });
}));
app.post('/api/v1/auth/logout', requireAuth, asyncRoute(async (req, res) => { await new Promise<void>((resolve, reject) => req.session.destroy(err => err ? reject(err) : resolve())); res.clearCookie('connect.sid'); res.status(204).send(); }));
app.get('/api/v1/auth/me', requireAuth, (_req, res) => { const user = res.locals.user; res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, departmentId: user.departmentId } }); });

app.get('/api/v1/dashboard', requireAuth, asyncRoute(async (_req, res) => {
  res.json(await getDashboard(res.locals.user));
}));

app.get('/api/v1/issues', requireAuth, asyncRoute(async (_req, res) => {
  res.json(await listIssues(res.locals.user));
}));
app.post('/api/v1/issues', requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ title: z.string().min(3).max(120), description: z.string().min(5).max(2000), category: z.enum(['SCHEDULE','ROOM','ATTENDANCE','INCIDENT','OTHER']), priority: z.enum(['LOW','MEDIUM','HIGH','CRITICAL']).default('MEDIUM'), scheduleId: z.string().cuid().optional() });
  const result = schema.safeParse(req.body); if (!result.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Issue details are invalid' } });
  const issue = await createIssue({ ...result.data, creatorId: res.locals.user.id }); res.status(201).json(issue);
}));
app.patch('/api/v1/issues/:id', requireAuth, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const result = z.object({ status: z.enum(['OPEN','IN_PROGRESS','RESOLVED','REJECTED']), assigneeId: z.string().cuid().nullable().optional() }).safeParse(req.body); if (!result.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Issue update is invalid' } });
  const issueId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const issue = await updateIssue(issueId, result.data);
  if (!issue) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Issue not found' } });
  res.json(issue);
}));

app.get('/api/v1/disruptions', requireAuth, asyncRoute(async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  res.json(await listDisruptions(res.locals.user, search));
}));
app.post('/api/v1/disruptions', requireAuth, requireRole('ADMIN', 'INVIGILATOR'), asyncRoute(async (req, res) => {
  const result = z.object({ title: z.string().min(3).max(140), description: z.string().min(10).max(4000), category: z.enum(['ROOM','INVIGILATOR','TIMETABLE','REGISTRATION','EQUIPMENT','WEATHER','ANNOUNCEMENT']), severity: z.enum(['LOW','MEDIUM','HIGH','CRITICAL']), scheduleId: z.string().optional(), affectedStartsAt: z.string().datetime().optional(), affectedEndsAt: z.string().datetime().optional(), requiresHodApproval: z.boolean().optional() }).safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Disruption details are invalid' } });
  res.status(201).json(await createDisruption(result.data, res.locals.user));
}));
app.post('/api/v1/disruptions/:id/recommend', requireAuth, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const disruptionId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const alternatives = await recommendAlternatives(disruptionId);
  if (!alternatives) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Disruption not found' } });
  res.json({ alternatives });
}));
app.get('/api/v1/disruptions/:id/alternatives', requireAuth, asyncRoute(async (req, res) => {
  const disruptionId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  res.json(await getAlternatives(disruptionId));
}));
app.post('/api/v1/disruptions/:id/approve', requireAuth, requireRole('HOD'), asyncRoute(async (req, res) => {
  const disruptionId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const result = z.object({ reason: z.string().min(5).max(1000) }).safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Approval reason is required' } });
  res.json(await approveDisruption(disruptionId, res.locals.user, result.data.reason));
}));
app.post('/api/v1/disruptions/:id/apply', requireAuth, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const disruptionId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const result = z.object({ alternativeId: z.string().min(1), reason: z.string().min(5).max(1000) }).safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Alternative and decision reason are required' } });
  try { res.json(await applyAlternative(disruptionId, result.data.alternativeId, res.locals.user, result.data.reason)); } catch (error) { res.status(409).json({ error: { code: 'CONFLICT', message: error instanceof Error ? error.message : 'The alternative can no longer be applied' } }); }
}));
app.get('/api/v1/risks', requireAuth, asyncRoute(async (_req, res) => { res.json(await listRisks(res.locals.user)); }));
app.post('/api/v1/reviews/:scheduleId', requireAuth, requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const scheduleId = typeof req.params.scheduleId === 'string' ? req.params.scheduleId : req.params.scheduleId[0];
  const result = z.object({ plannedAttendance: z.number().int().nonnegative().optional(), actualAttendance: z.number().int().nonnegative().optional(), plannedRoomCount: z.number().int().nonnegative().optional(), actualRoomCount: z.number().int().nonnegative().optional(), invigilatorCoverage: z.number().int().nonnegative().optional(), disruptionCount: z.number().int().nonnegative().optional(), resolutionMinutes: z.number().int().nonnegative().optional(), alternativeWorked: z.boolean().optional(), lessonsLearned: z.string().max(4000).optional(), preventiveActions: z.string().max(4000).optional() }).safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Review details are invalid' } });
  res.status(201).json(await saveReview(scheduleId, result.data, res.locals.user));
}));

app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html')) return res.sendFile(path.resolve(__dirname, '../../web/dist/index.html'));
  next();
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { console.error('request_error', err instanceof Error ? err.message : 'unknown'); res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } }); });

if (require.main === module) app.listen(Number(process.env.PORT ?? 4000), () => console.log(`ExamOps API listening on ${process.env.PORT ?? 4000}`));
export { app };
