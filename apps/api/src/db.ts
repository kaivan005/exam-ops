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

export async function updateIssue(id: string, input: { status: string; assigneeId?: string | null }) {
  const result = await pool.query<Issue>('UPDATE "IssueReport" SET "status" = $1::"IssueStatus", "assigneeId" = COALESCE($2, "assigneeId"), "updatedAt" = NOW() WHERE "id" = $3 RETURNING "id", "title", "description", "category", "priority", "status", "createdAt"', [input.status, input.assigneeId ?? null, id]);
  return result.rows[0] ?? null;
}

export async function closeDatabase() {
  await pool.end();
}
