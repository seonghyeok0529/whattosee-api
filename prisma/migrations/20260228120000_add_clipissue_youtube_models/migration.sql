CREATE TABLE "ClipIssueYoutubeIngest" (
  "id" TEXT NOT NULL,
  "clipIssueId" TEXT NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL,
  "params" JSONB NOT NULL,
  "videoCount" INTEGER NOT NULL,
  "commentCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ClipIssueYoutubeIngest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClipIssueYoutubeAnalyticsCache" (
  "id" TEXT NOT NULL,
  "clipIssueId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ClipIssueYoutubeAnalyticsCache_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClipIssueYoutubeIngest_clipIssueId_fetchedAt_idx"
  ON "ClipIssueYoutubeIngest"("clipIssueId", "fetchedAt");

CREATE UNIQUE INDEX "ClipIssueYoutubeAnalyticsCache_clipIssueId_key"
  ON "ClipIssueYoutubeAnalyticsCache"("clipIssueId");

CREATE INDEX "ClipIssueYoutubeAnalyticsCache_expiresAt_idx"
  ON "ClipIssueYoutubeAnalyticsCache"("expiresAt");

ALTER TABLE "ClipIssueYoutubeIngest"
  ADD CONSTRAINT "ClipIssueYoutubeIngest_clipIssueId_fkey"
  FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClipIssueYoutubeAnalyticsCache"
  ADD CONSTRAINT "ClipIssueYoutubeAnalyticsCache_clipIssueId_fkey"
  FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
