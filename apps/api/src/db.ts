import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

dotenv.config();
dotenv.config({ path: "../../.env" });

export type Role = "ADMIN" | "STUDENT" | "INVIGILATOR" | "HOD";
export type User = { id: string; email: string; name: string; passwordHash: string; role: Role; departmentId: string | null; isActive: boolean };
export type Issue = { id: string; title: string; description: string; category: string; priority: string; status: string; createdAt: Date; creator?: { name: string; email: string } };

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === "false" ? { rejectUnauthorized: false } : undefined,
});

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function writeAudit(client: PoolClient, actorId: string | null, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) {
  await client.query('INSERT INTO "AuditLog" ("id", "actorId", "action", "entityType", "entityId", "metadata", "createdAt") VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())', [randomUUID(), actorId, action, entityType, entityId, JSON.stringify(metadata)]);
}

export async function getUserById(id: string) {
  const result = await pool.query<User>('SELECT "id", "email", "name", "passwordHash", "role", "departmentId", "isActive" FROM "User" WHERE "id" = $1 LIMIT 1', [id]);
  return result.rows[0] ?? null;
}

export async function getUserByEmail(email: string) {
  const result = await pool.query<User>('SELECT "id", "email", "name", "passwordHash", "role", "departmentId", "isActive" FROM "User" WHERE lower("email") = lower($1) LIMIT 1', [email]);
  return result.rows[0] ?? null;
}

export async function getDashboard(user: User) {
  const filters = user.role === "HOD" && user.departmentId ? "AND es.\"departmentId\" = $1" : "";
  const params = user.role === "HOD" && user.departmentId ? [user.departmentId] : [];
  const schedulesResult = await pool.query(
    `SELECT es."id", es."startsAt", es."endsAt", es."status", s."name" AS "subjectName", er."code" AS "roomCode"
     FROM "ExaminationSchedule" es
     JOIN "Subject" s ON s."id" = es."subjectId"
     LEFT JOIN "RoomAllocation" ra ON ra."scheduleId" = es."id"
     LEFT JOIN "ExaminationRoom" er ON er."id" = ra."roomId"
     WHERE es."status" <> 'CANCELLED' ${filters}
     ORDER BY es."startsAt" ASC LIMIT 10`, params);
  const issueParams = user.role === "STUDENT" || user.role === "INVIGILATOR" ? [user.id] : [];
  const issueFilter = issueParams.length ? '"creatorId" = $1 AND' : "";
  const [issues, rooms, notifications] = await Promise.all([
    pool.query(`SELECT count(*)::int AS "count" FROM "IssueReport" WHERE ${issueFilter} "status" <> 'RESOLVED'`, issueParams),
    pool.query('SELECT count(*)::int AS "count" FROM "ExaminationRoom"'),
    pool.query('SELECT "id", "title", "message", "readAt", "createdAt" FROM "Notification" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 5', [user.id]),
  ]);
  const schedules = schedulesResult.rows.map((row) => ({
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    subject: { name: row.subjectName },
    roomAllocations: row.roomCode ? [{ room: { code: row.roomCode } }] : [],
  }));
  return { stats: { totalExams: schedules.length, upcoming: schedules.filter((schedule) => new Date(schedule.startsAt) > new Date()).length, unresolvedIssues: issues.rows[0].count, rooms: rooms.rows[0].count }, schedules, notifications: notifications.rows };
}

export async function listSchedules(user: User) {
  const conditions: string[] = ['es."status" <> \'CANCELLED\''];
  const params: string[] = [];
  if (user.role === "HOD" && user.departmentId) { params.push(user.departmentId); conditions.push(`es."departmentId" = $${params.length}`); }
  if (user.role === "STUDENT") { params.push(user.id); conditions.push(`EXISTS (SELECT 1 FROM "ExamRegistration" er JOIN "StudentProfile" sp ON sp."id" = er."studentId" WHERE er."subjectId" = es."subjectId" AND er."sessionId" = es."sessionId" AND sp."userId" = $${params.length})`, `es."status" = 'PUBLISHED'`); }
  if (user.role === "INVIGILATOR") { params.push(user.id); conditions.push(`EXISTS (SELECT 1 FROM "InvigilatorAssignment" ia JOIN "InvigilatorProfile" ip ON ip."id" = ia."invigilatorId" WHERE ia."scheduleId" = es."id" AND ip."userId" = $${params.length})`); }
  const result = await pool.query(`SELECT es."id", es."startsAt", es."endsAt", es."status", s."code" AS "subjectCode", s."name" AS "subjectName", d."name" AS "departmentName", COALESCE(string_agg(DISTINCT er."code", ', '), 'Unassigned') AS "rooms", count(DISTINCT ia."id")::int AS "invigilatorCount" FROM "ExaminationSchedule" es JOIN "Subject" s ON s."id" = es."subjectId" JOIN "Department" d ON d."id" = es."departmentId" LEFT JOIN "RoomAllocation" ra ON ra."scheduleId" = es."id" LEFT JOIN "ExaminationRoom" er ON er."id" = ra."roomId" LEFT JOIN "InvigilatorAssignment" ia ON ia."scheduleId" = es."id" WHERE ${conditions.join(' AND ')} GROUP BY es."id", s."code", s."name", d."name" ORDER BY es."startsAt" ASC`, params);
  return result.rows;
}

export async function listRooms() {
  const result = await pool.query('SELECT er."id", er."code", er."building", er."capacity", count(DISTINCT ra."id")::int AS "allocationCount" FROM "ExaminationRoom" er LEFT JOIN "RoomAllocation" ra ON ra."roomId" = er."id" GROUP BY er."id", er."code", er."building", er."capacity" ORDER BY er."building", er."code"');
  return result.rows;
}

export async function listIssues(user: User) {
  const where = user.role === "ADMIN" || user.role === "HOD" ? "" : 'WHERE ir."creatorId" = $1';
  const params = where ? [user.id] : [];
  const result = await pool.query<Issue>(`SELECT ir."id", ir."title", ir."description", ir."category", ir."priority", ir."status", ir."createdAt", u."name" AS "creatorName", u."email" AS "creatorEmail" FROM "IssueReport" ir JOIN "User" u ON u."id" = ir."creatorId" ${where} ORDER BY ir."createdAt" DESC`, params);
  return result.rows.map((issue) => ({ ...issue, creator: { name: (issue as Issue & { creatorName: string }).creatorName, email: (issue as Issue & { creatorEmail: string }).creatorEmail } }));
}

export async function createIssue(input: { creatorId: string; title: string; description: string; category: string; priority: string; scheduleId?: string }) {
  const result = await pool.query<Issue>('INSERT INTO "IssueReport" ("id", "creatorId", "scheduleId", "category", "priority", "status", "title", "description", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4::"IssueCategory", $5::"IssuePriority", \'OPEN\'::"IssueStatus", $6, $7, NOW(), NOW()) RETURNING "id", "title", "description", "category", "priority", "status", "createdAt"', [randomUUID(), input.creatorId, input.scheduleId ?? null, input.category, input.priority, input.title, input.description]);
  return result.rows[0];
}

export async function updateIssue(id: string, input: { status: string; assigneeId?: string | null }, actorId?: string) {
  const result = await pool.query<Issue>('UPDATE "IssueReport" SET "status" = $1::"IssueStatus", "assigneeId" = COALESCE($2, "assigneeId"), "updatedAt" = NOW() WHERE "id" = $3 RETURNING "id", "title", "description", "category", "priority", "status", "createdAt"', [input.status, input.assigneeId ?? null, id]);
  if (result.rows[0] && actorId) await pool.query('INSERT INTO "AuditLog" ("id", "actorId", "action", "entityType", "entityId", "metadata", "createdAt") VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())', [randomUUID(), actorId, "ISSUE_STATUS_CHANGED", "IssueReport", id, JSON.stringify({ status: input.status, assigneeId: input.assigneeId ?? null })]);
  return result.rows[0] ?? null;
}

export async function listNotifications(userId: string) {
  const result = await pool.query('SELECT "id", "title", "message", "scheduleId", "readAt", "createdAt" FROM "Notification" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 50', [userId]);
  return result.rows;
}

export async function markNotificationRead(id: string, userId: string) {
  const result = await pool.query('UPDATE "Notification" SET "readAt" = COALESCE("readAt", NOW()) WHERE "id" = $1 AND "userId" = $2 RETURNING "id", "readAt"', [id, userId]);
  return result.rows[0] ?? null;
}

export async function listAuditLogs(user: User) {
  const scope = user.role === "ADMIN" ? "" : 'WHERE u."departmentId" = $1';
  const params = user.role === "ADMIN" ? [] : [user.departmentId];
  const result = await pool.query(`SELECT al."id", al."action", al."entityType", al."entityId", al."metadata", al."createdAt", u."name" AS "actorName" FROM "AuditLog" al LEFT JOIN "User" u ON u."id" = al."actorId" ${scope} ORDER BY al."createdAt" DESC LIMIT 200`, params);
  return result.rows;
}

export async function closeDatabase() {
  await pool.end();
}
