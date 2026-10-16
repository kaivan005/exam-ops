import { randomUUID } from "node:crypto";
import { pool, withTransaction, type User } from "./db";

type DisruptionInput = { title: string; description: string; category: string; severity: string; scheduleId?: string; affectedStartsAt?: string; affectedEndsAt?: string; requiresHodApproval?: boolean };

export async function listDisruptions(user: User, search = "") {
  const scope = user.role === "ADMIN" ? "" : user.role === "HOD" && user.departmentId ? 'AND es."departmentId" = $2' : 'AND ed."reportedById" = $2';
  const params: string[] = [`%${search}%`];
  if (scope) params.push(user.departmentId ?? user.id);
  const result = await pool.query(`SELECT ed.*, es."startsAt" AS "scheduleStartsAt", s."name" AS "subjectName", u."name" AS "reportedByName", (SELECT count(*)::int FROM "DisruptionAlternative" da WHERE da."disruptionId" = ed."id") AS "alternativeCount" FROM "ExamDisruption" ed LEFT JOIN "ExaminationSchedule" es ON es."id" = ed."scheduleId" LEFT JOIN "Subject" s ON s."id" = es."subjectId" JOIN "User" u ON u."id" = ed."reportedById" WHERE (ed."title" ILIKE $1 OR ed."description" ILIKE $1 OR ed."category" ILIKE $1) ${scope} ORDER BY ed."createdAt" DESC`, params);
  return result.rows;
}

export async function createDisruption(input: DisruptionInput, reporter: User) {
  const id = randomUUID();
  await pool.query('INSERT INTO "ExamDisruption" ("id", "title", "description", "category", "severity", "scheduleId", "affectedStartsAt", "affectedEndsAt", "reportedById", "requiresHodApproval") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [id, input.title, input.description, input.category, input.severity, input.scheduleId ?? null, input.affectedStartsAt ?? null, input.affectedEndsAt ?? null, reporter.id, input.requiresHodApproval ?? reporter.role === "HOD"]);
  return { id, status: "REPORTED" };
}

export async function recommendAlternatives(disruptionId: string) {
  const disruption = await pool.query<{ id: string; category: string; scheduleId: string | null; startsAt: Date | null; endsAt: Date | null }>('SELECT ed."id", ed."category", ed."scheduleId", COALESCE(ed."affectedStartsAt", es."startsAt") AS "startsAt", COALESCE(ed."affectedEndsAt", es."endsAt") AS "endsAt" FROM "ExamDisruption" ed LEFT JOIN "ExaminationSchedule" es ON es."id" = ed."scheduleId" WHERE ed."id" = $1', [disruptionId]);
  const target = disruption.rows[0];
  if (!target) return null;
  return withTransaction(async (client) => {
    await client.query('DELETE FROM "DisruptionAlternative" WHERE "disruptionId" = $1', [disruptionId]);
    let alternatives: Array<{ kind: string; title: string; rationale: string; roomId?: string; invigilatorId?: string; score: number }> = [];
    if (target.category === "ROOM" && target.scheduleId && target.startsAt && target.endsAt) {
      const candidates = await client.query<{ id: string; code: string; capacity: number; studentCount: number }>(`SELECT er."id", er."code", er."capacity", count(DISTINCT erx."studentId")::int AS "studentCount" FROM "ExaminationRoom" er LEFT JOIN (SELECT er2."id", r."studentId" FROM "ExamRegistration" r JOIN "ExaminationSchedule" es2 ON es2."subjectId" = r."subjectId" AND es2."sessionId" = r."sessionId" JOIN "RoomAllocation" ra2 ON ra2."scheduleId" = es2."id" JOIN "ExaminationRoom" er2 ON er2."id" = ra2."roomId" WHERE es2."id" = $1) erx ON erx."id" = er."id" WHERE er."capacity" >= (SELECT count(*) FROM "ExamRegistration" r3 JOIN "ExaminationSchedule" es3 ON es3."subjectId" = r3."subjectId" AND es3."sessionId" = r3."sessionId" WHERE es3."id" = $1) AND NOT EXISTS (SELECT 1 FROM "RoomAllocation" ra JOIN "ExaminationSchedule" busy ON busy."id" = ra."scheduleId" WHERE ra."roomId" = er."id" AND busy."startsAt" < $3 AND busy."endsAt" > $2) GROUP BY er."id", er."code", er."capacity" ORDER BY er."capacity" ASC`, [target.scheduleId, target.startsAt, target.endsAt]);
      alternatives = candidates.rows.map((room) => ({ kind: "ROOM", title: `Move to ${room.code}`, rationale: `${room.code} has capacity for ${room.studentCount || "all registered"} students and has no overlapping reservation.`, roomId: room.id, score: Math.max(1, 100 - (room.capacity - room.studentCount)) }));
      if (!alternatives.length) alternatives.push({ kind: "MANUAL", title: "Manual room review required", rationale: "No unreserved room with enough capacity was found for the affected registration set.", score: 0 });
    } else if (target.category === "INVIGILATOR" && target.scheduleId && target.startsAt && target.endsAt) {
      const candidates = await client.query<{ id: string; name: string }>(`SELECT ip."id", u."name" FROM "InvigilatorProfile" ip JOIN "User" u ON u."id" = ip."userId" WHERE u."isActive" = true AND NOT EXISTS (SELECT 1 FROM "InvigilatorAssignment" ia JOIN "ExaminationSchedule" busy ON busy."id" = ia."scheduleId" WHERE ia."invigilatorId" = ip."id" AND busy."startsAt" < $2 AND busy."endsAt" > $1) ORDER BY u."name"`, [target.startsAt, target.endsAt]);
      alternatives = candidates.rows.map((person, index) => ({ kind: "INVIGILATOR", title: `Assign ${person.name}`, rationale: `${person.name} is active and has no overlapping invigilation duty.`, invigilatorId: person.id, score: 100 - index }));
      if (!alternatives.length) alternatives.push({ kind: "MANUAL", title: "Manual invigilator review required", rationale: "No active invigilator without an overlapping assignment was found.", score: 0 });
    } else {
      alternatives = [{ kind: "MANUAL", title: "Manual impact review required", rationale: "This disruption category needs an administrator to evaluate its timetable and communication consequences.", score: 0 }];
    }
    for (const alternative of alternatives) await client.query('INSERT INTO "DisruptionAlternative" ("id", "disruptionId", "kind", "title", "rationale", "roomId", "invigilatorId", "score") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), disruptionId, alternative.kind, alternative.title, alternative.rationale, alternative.roomId ?? null, alternative.invigilatorId ?? null, alternative.score]);
    await client.query('UPDATE "ExamDisruption" SET "status" = \'ALTERNATIVES_PROPOSED\', "updatedAt" = NOW() WHERE "id" = $1', [disruptionId]);
    return alternatives;
  });
}

export async function getAlternatives(disruptionId: string) {
  const result = await pool.query('SELECT * FROM "DisruptionAlternative" WHERE "disruptionId" = $1 ORDER BY "score" DESC, "createdAt" ASC', [disruptionId]);
  return result.rows;
}

export async function applyAlternative(disruptionId: string, alternativeId: string, actor: User, reason: string) {
  return withTransaction(async (client) => {
    const disruption = await client.query<{ scheduleId: string | null; status: string; requiresHodApproval: boolean }>('SELECT "scheduleId", "status", "requiresHodApproval" FROM "ExamDisruption" WHERE "id" = $1 FOR UPDATE', [disruptionId]);
    const item = disruption.rows[0];
    if (!item) return null;
    if (item.requiresHodApproval && actor.role !== "HOD") throw new Error("HOD approval is required before applying this resolution");
    const alternative = await client.query<{ kind: string; roomId: string | null; invigilatorId: string | null }>('SELECT "kind", "roomId", "invigilatorId" FROM "DisruptionAlternative" WHERE "id" = $1 AND "disruptionId" = $2', [alternativeId, disruptionId]);
    const selected = alternative.rows[0];
    if (!selected) return null;
    if (selected.kind === "ROOM" && item.scheduleId && selected.roomId) {
      const conflict = await client.query('SELECT 1 FROM "RoomAllocation" ra JOIN "ExaminationSchedule" es ON es."id" = ra."scheduleId" WHERE ra."roomId" = $1 AND es."id" <> $2 AND es."startsAt" < (SELECT "endsAt" FROM "ExaminationSchedule" WHERE "id" = $2) AND es."endsAt" > (SELECT "startsAt" FROM "ExaminationSchedule" WHERE "id" = $2) LIMIT 1', [selected.roomId, item.scheduleId]);
      if (conflict.rowCount) throw new Error("The selected room is no longer available; regenerate alternatives");
      await client.query('DELETE FROM "RoomAllocation" WHERE "scheduleId" = $1', [item.scheduleId]);
      await client.query('INSERT INTO "RoomAllocation" ("id", "scheduleId", "roomId") VALUES ($1, $2, $3)', [randomUUID(), item.scheduleId, selected.roomId]);
    }
    if (selected.kind === "INVIGILATOR" && item.scheduleId && selected.invigilatorId) await client.query('INSERT INTO "InvigilatorAssignment" ("id", "scheduleId", "invigilatorId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [randomUUID(), item.scheduleId, selected.invigilatorId]);
    await client.query('UPDATE "DisruptionAlternative" SET "status" = CASE WHEN "id" = $1 THEN \'SELECTED\' ELSE \'REJECTED\' END WHERE "disruptionId" = $2', [alternativeId, disruptionId]);
    await client.query('UPDATE "ExamDisruption" SET "status" = \'RESOLVED\', "resolution" = $1, "resolvedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = $2', [reason, disruptionId]);
    await client.query('INSERT INTO "DisruptionDecision" ("id", "disruptionId", "alternativeId", "actorId", "fromStatus", "toStatus", "reason") VALUES ($1, $2, $3, $4, $5, \'RESOLVED\', $6)', [randomUUID(), disruptionId, alternativeId, actor.id, item.status, reason]);
    if (item.scheduleId) {
      const users = await client.query<{ userId: string }>('SELECT DISTINCT u."id" AS "userId" FROM "ExamRegistration" er JOIN "ExaminationSchedule" es ON es."subjectId" = er."subjectId" AND es."sessionId" = er."sessionId" JOIN "StudentProfile" sp ON sp."id" = er."studentId" JOIN "User" u ON u."id" = sp."userId" WHERE es."id" = $1', [item.scheduleId]);
      for (const user of users.rows) await client.query('INSERT INTO "Notification" ("id", "userId", "scheduleId", "title", "message", "createdAt") VALUES ($1, $2, $3, $4, $5, NOW())', [randomUUID(), user.userId, item.scheduleId, "Examination arrangement updated", reason]);
    }
    return { status: "RESOLVED" };
  });
}

export async function approveDisruption(disruptionId: string, actor: User, reason: string) {
  return withTransaction(async (client) => {
    const current = await client.query<{ status: string; requiresHodApproval: boolean; departmentId: string | null }>('SELECT ed."status", ed."requiresHodApproval", es."departmentId" FROM "ExamDisruption" ed LEFT JOIN "ExaminationSchedule" es ON es."id" = ed."scheduleId" WHERE ed."id" = $1 FOR UPDATE', [disruptionId]);
    if (!current.rows[0]) return null;
    if (actor.departmentId && current.rows[0].departmentId && actor.departmentId !== current.rows[0].departmentId) throw new Error("This disruption belongs to another department");
    await client.query('UPDATE "ExamDisruption" SET "requiresHodApproval" = false, "status" = \'ALTERNATIVES_PROPOSED\', "updatedAt" = NOW() WHERE "id" = $1', [disruptionId]);
    await client.query('INSERT INTO "DisruptionDecision" ("id", "disruptionId", "actorId", "fromStatus", "toStatus", "reason") VALUES ($1, $2, $3, $4, \'ALTERNATIVES_PROPOSED\', $5)', [randomUUID(), disruptionId, actor.id, current.rows[0].status, reason]);
    return { status: "ALTERNATIVES_PROPOSED" };
  });
}

export async function listRisks(user: User) {
  const department = user.role === "HOD" && user.departmentId ? 'WHERE es."departmentId" = $1' : "";
  const params = user.role === "HOD" && user.departmentId ? [user.departmentId] : [];
  const result = await pool.query(`SELECT es."id", s."name" AS "subjectName", es."startsAt", es."status", count(DISTINCT ra."id")::int AS "roomCount", COALESCE(sum(DISTINCT er."capacity"), 0)::int AS "totalCapacity", count(DISTINCT ia."id")::int AS "invigilatorCount", (SELECT count(*)::int FROM "ExamRegistration" er2 WHERE er2."subjectId" = es."subjectId" AND er2."sessionId" = es."sessionId") AS "studentCount", (SELECT count(*)::int FROM "ScheduleApproval" sa WHERE sa."scheduleId" = es."id" AND sa."decision" = 'APPROVED') AS "approvedCount" FROM "ExaminationSchedule" es JOIN "Subject" s ON s."id" = es."subjectId" LEFT JOIN "RoomAllocation" ra ON ra."scheduleId" = es."id" LEFT JOIN "ExaminationRoom" er ON er."id" = ra."roomId" LEFT JOIN "InvigilatorAssignment" ia ON ia."scheduleId" = es."id" ${department} GROUP BY es."id", s."name" ORDER BY es."startsAt" ASC`, params);
  return result.rows.map((row) => {
    const risks: Array<{ level: string; reason: string }> = [];
    if (!row.roomCount) risks.push({ level: "HIGH", reason: "No room allocation is recorded." });
    if (row.roomCount && row.totalCapacity < row.studentCount) risks.push({ level: "HIGH", reason: `Allocated capacity (${row.totalCapacity}) is below registrations (${row.studentCount}).` });
    if (!row.invigilatorCount) risks.push({ level: "HIGH", reason: "No invigilator coverage is recorded." });
    if (row.status !== "PUBLISHED") risks.push({ level: "MEDIUM", reason: "The schedule is not published." });
    if (new Date(row.startsAt).getTime() - Date.now() < 1000 * 60 * 60 * 72 && row.status !== "PUBLISHED") risks.push({ level: "MEDIUM", reason: "Approval or publication is pending within 72 hours of the exam." });
    if (!risks.length) risks.push({ level: "LOW", reason: "Room, invigilator, and publication checks are currently complete." });
    return { ...row, risks };
  });
}

export async function saveReview(scheduleId: string, input: Record<string, unknown>, actor: User) {
  const values = [input.plannedAttendance ?? null, input.actualAttendance ?? null, input.plannedRoomCount ?? null, input.actualRoomCount ?? null, input.invigilatorCoverage ?? null, input.disruptionCount ?? 0, input.resolutionMinutes ?? null, input.alternativeWorked ?? null, input.lessonsLearned ?? null, input.preventiveActions ?? null];
  const result = await pool.query('INSERT INTO "ExaminationReview" ("id", "scheduleId", "plannedAttendance", "actualAttendance", "plannedRoomCount", "actualRoomCount", "invigilatorCoverage", "disruptionCount", "resolutionMinutes", "alternativeWorked", "lessonsLearned", "preventiveActions", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW()) ON CONFLICT ("scheduleId") DO UPDATE SET "plannedAttendance" = EXCLUDED."plannedAttendance", "actualAttendance" = EXCLUDED."actualAttendance", "plannedRoomCount" = EXCLUDED."plannedRoomCount", "actualRoomCount" = EXCLUDED."actualRoomCount", "invigilatorCoverage" = EXCLUDED."invigilatorCoverage", "disruptionCount" = EXCLUDED."disruptionCount", "resolutionMinutes" = EXCLUDED."resolutionMinutes", "alternativeWorked" = EXCLUDED."alternativeWorked", "lessonsLearned" = EXCLUDED."lessonsLearned", "preventiveActions" = EXCLUDED."preventiveActions", "updatedAt" = NOW() RETURNING *', [randomUUID(), scheduleId, ...values, actor.id]);
  return result.rows[0];
}
