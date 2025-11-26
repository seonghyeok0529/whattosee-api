-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'UNKNOWN');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "ageRange" TEXT,
ADD COLUMN     "birthYear" INTEGER,
ADD COLUMN     "gender" "Gender",
ADD COLUMN     "regionLevel1" TEXT,
ADD COLUMN     "regionLevel2" TEXT;

-- CreateTable
CREATE TABLE "EventLog" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "pagePath" TEXT,
    "section" TEXT,
    "issueId" TEXT,
    "issueTitle" TEXT,
    "ctiTypeSnapshot" TEXT,
    "regionLevel1Snapshot" TEXT,
    "regionLevel2Snapshot" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventLog_eventType_createdAt_idx" ON "EventLog"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "EventLog_sessionId_createdAt_idx" ON "EventLog"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "EventLog_userId_createdAt_idx" ON "EventLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EventLog_issueId_createdAt_idx" ON "EventLog"("issueId", "createdAt");

-- AddForeignKey
ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
