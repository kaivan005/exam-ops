CREATE TABLE IF NOT EXISTS "ExamDisruption" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "category" TEXT NOT NULL CHECK ("category" IN ('ROOM','INVIGILATOR','TIMETABLE','REGISTRATION','EQUIPMENT','WEATHER','ANNOUNCEMENT')),
  "severity" TEXT NOT NULL CHECK ("severity" IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  "scheduleId" TEXT REFERENCES "ExaminationSchedule"("id") ON DELETE SET NULL,
  "affectedStartsAt" TIMESTAMP(3),
  "affectedEndsAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'REPORTED' CHECK ("status" IN ('REPORTED','UNDER_REVIEW','ALTERNATIVES_PROPOSED','AWAITING_APPROVAL','RESOLVED','CLOSED')),
  "reportedById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "resolution" TEXT,
  "finalOutcome" TEXT,
  "requiresHodApproval" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS "DisruptionAlternative" (
  "id" TEXT PRIMARY KEY,
  "disruptionId" TEXT NOT NULL REFERENCES "ExamDisruption"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('ROOM','INVIGILATOR','TIMETABLE','MANUAL')),
  "title" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "roomId" TEXT REFERENCES "ExaminationRoom"("id") ON DELETE SET NULL,
  "invigilatorId" TEXT REFERENCES "InvigilatorProfile"("id") ON DELETE SET NULL,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "score" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'PROPOSED' CHECK ("status" IN ('PROPOSED','SELECTED','REJECTED')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "DisruptionDecision" (
  "id" TEXT PRIMARY KEY,
  "disruptionId" TEXT NOT NULL REFERENCES "ExamDisruption"("id") ON DELETE CASCADE,
  "alternativeId" TEXT REFERENCES "DisruptionAlternative"("id") ON DELETE SET NULL,
  "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "fromStatus" TEXT,
  "toStatus" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "ExaminationReview" (
  "id" TEXT PRIMARY KEY,
  "scheduleId" TEXT NOT NULL UNIQUE REFERENCES "ExaminationSchedule"("id") ON DELETE CASCADE,
  "plannedAttendance" INTEGER,
  "actualAttendance" INTEGER,
  "plannedRoomCount" INTEGER,
  "actualRoomCount" INTEGER,
  "invigilatorCoverage" INTEGER,
  "disruptionCount" INTEGER NOT NULL DEFAULT 0,
  "resolutionMinutes" INTEGER,
  "alternativeWorked" BOOLEAN,
  "lessonsLearned" TEXT,
  "preventiveActions" TEXT,
  "createdById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ExamDisruption_status_createdAt_idx" ON "ExamDisruption" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "ExamDisruption_scheduleId_idx" ON "ExamDisruption" ("scheduleId");
CREATE INDEX IF NOT EXISTS "DisruptionAlternative_disruptionId_score_idx" ON "DisruptionAlternative" ("disruptionId", "score" DESC);
