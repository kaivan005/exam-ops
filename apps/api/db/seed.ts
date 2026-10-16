import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { pool, withTransaction } from "../src/db";

async function main() {
  await withTransaction(async (client) => {
    const departmentId = randomUUID();
    await client.query('INSERT INTO "Department" ("id", "code", "name") VALUES ($1, $2, $3) ON CONFLICT ("code") DO NOTHING', [departmentId, "CSE", "Computer Science & Engineering"]);
    const department = await client.query<{ id: string }>('SELECT "id" FROM "Department" WHERE "code" = $1', ["CSE"]);
    const resolvedDepartmentId = department.rows[0].id;
    const passwordHash = await argon2.hash("ExamOps-Demo-2026!");
    const users = [
      ["admin@examops.local", "Aarav Sharma", "ADMIN"],
      ["hod@examops.local", "Dr. Meera Iyer", "HOD"],
    ] as const;
    for (const [email, name, role] of users) {
      await client.query('INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "departmentId", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5::"Role", $6, true, NOW(), NOW()) ON CONFLICT ("email") DO NOTHING', [randomUUID(), email, name, passwordHash, role, resolvedDepartmentId]);
    }
    for (const [index, name] of ["Riya Patel", "Kabir Singh", "Ananya Rao"].entries()) {
      const email = `student${index + 1}@examops.local`;
      const userId = randomUUID();
      await client.query('INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "departmentId", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, \'STUDENT\'::"Role", $5, true, NOW(), NOW()) ON CONFLICT ("email") DO NOTHING', [userId, email, name, passwordHash, resolvedDepartmentId]);
      const user = await client.query<{ id: string }>('SELECT "id" FROM "User" WHERE "email" = $1', [email]);
      await client.query('INSERT INTO "StudentProfile" ("id", "userId", "institutionalId", "program", "year") VALUES ($1, $2, $3, $4, $5) ON CONFLICT ("userId") DO NOTHING', [randomUUID(), user.rows[0].id, `CSE2026${String(index + 1).padStart(3, "0")}`, "B.Tech Computer Science", 3]);
    }
    for (const [index, name] of ["Neel Joshi", "Sara Khan"].entries()) {
      const email = `invigilator${index + 1}@examops.local`;
      const userId = randomUUID();
      await client.query('INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "departmentId", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, \'INVIGILATOR\'::"Role", $5, true, NOW(), NOW()) ON CONFLICT ("email") DO NOTHING', [userId, email, name, passwordHash, resolvedDepartmentId]);
      const user = await client.query<{ id: string }>('SELECT "id" FROM "User" WHERE "email" = $1', [email]);
      await client.query('INSERT INTO "InvigilatorProfile" ("id", "userId", "employeeId") VALUES ($1, $2, $3) ON CONFLICT ("userId") DO NOTHING', [randomUUID(), user.rows[0].id, `INV2026${String(index + 1).padStart(3, "0")}`]);
    }
    for (const [code, name] of [["CS301", "Distributed Systems"], ["CS302", "Secure Software Engineering"]]) await client.query('INSERT INTO "Course" ("id", "code", "name", "departmentId") VALUES ($1, $2, $3, $4) ON CONFLICT ("code") DO NOTHING', [randomUUID(), code, name, resolvedDepartmentId]);
    for (const [code, name, courseCode] of [["CS301A", "Distributed Systems", "CS301"], ["CS302A", "Secure Software Engineering", "CS302"]]) {
      const course = await client.query<{ id: string }>('SELECT "id" FROM "Course" WHERE "code" = $1', [courseCode]);
      await client.query('INSERT INTO "Subject" ("id", "code", "name", "courseId", "departmentId") VALUES ($1, $2, $3, $4, $5) ON CONFLICT ("code") DO NOTHING', [randomUUID(), code, name, course.rows[0].id, resolvedDepartmentId]);
    }
    for (const [code, capacity] of [["A-101", 60], ["A-202", 45], ["B-105", 30]] as Array<[string, number]>) await client.query('INSERT INTO "ExaminationRoom" ("id", "code", "building", "capacity") VALUES ($1, $2, $3, $4) ON CONFLICT ("code") DO NOTHING', [randomUUID(), code, "Academic Block", capacity]);
  });
  console.log("Seeded ExamOps demo data in Aiven PostgreSQL.");
}

main().catch((error) => { console.error("seed_failed", error instanceof Error ? error.message : "unknown"); process.exitCode = 1; }).finally(() => pool.end());
