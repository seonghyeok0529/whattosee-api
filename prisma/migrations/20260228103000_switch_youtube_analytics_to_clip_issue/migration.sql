-- Drop existing foreign keys to Issue
ALTER TABLE "IssueYoutubeIngest" DROP CONSTRAINT "IssueYoutubeIngest_issueId_fkey";
ALTER TABLE "IssueYoutubeAnalyticsCache" DROP CONSTRAINT "IssueYoutubeAnalyticsCache_issueId_fkey";

-- Drop indexes referencing old column names
DROP INDEX "IssueYoutubeIngest_issueId_fetchedAt_idx";
DROP INDEX "IssueYoutubeAnalyticsCache_issueId_key";

-- Rename relation columns to ClipIssue references
ALTER TABLE "IssueYoutubeIngest" RENAME COLUMN "issueId" TO "clipIssueId";
ALTER TABLE "IssueYoutubeAnalyticsCache" RENAME COLUMN "issueId" TO "clipIssueId";

-- Recreate indexes for ClipIssue relation
CREATE INDEX "IssueYoutubeIngest_clipIssueId_fetchedAt_idx" ON "IssueYoutubeIngest"("clipIssueId", "fetchedAt");
CREATE UNIQUE INDEX "IssueYoutubeAnalyticsCache_clipIssueId_key" ON "IssueYoutubeAnalyticsCache"("clipIssueId");

-- Add new foreign keys to ClipIssue
ALTER TABLE "IssueYoutubeIngest" ADD CONSTRAINT "IssueYoutubeIngest_clipIssueId_fkey" FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueYoutubeAnalyticsCache" ADD CONSTRAINT "IssueYoutubeAnalyticsCache_clipIssueId_fkey" FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
