import "../src/db";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pool } from "../src/db";

async function main() {
  await pool.query('CREATE TABLE IF NOT EXISTS "ExamOpsSqlMigration" ("name" TEXT PRIMARY KEY, "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const directory = path.resolve(process.cwd(), "db/migrations");
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of entries) {
    const existing = await pool.query('SELECT 1 FROM "ExamOpsSqlMigration" WHERE "name" = $1', [name]);
    if (existing.rowCount) continue;
    if (name.includes("20261016182221") && (await pool.query("SELECT to_regclass('public.\"User\"') AS \"table\"")).rows[0].table) {
      await pool.query('INSERT INTO "ExamOpsSqlMigration" ("name") VALUES ($1)', [name]);
      console.log(`Marked existing base schema as applied: ${name}`);
      continue;
    }
    const sqlPath = path.join(directory, name, "migration.sql");
    const sql = await readFile(sqlPath, "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO "ExamOpsSqlMigration" ("name") VALUES ($1)', [name]);
      await pool.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
}

main().catch((error) => { console.error("migration_failed", error instanceof Error ? error.message : "unknown"); process.exitCode = 1; }).finally(() => pool.end());
