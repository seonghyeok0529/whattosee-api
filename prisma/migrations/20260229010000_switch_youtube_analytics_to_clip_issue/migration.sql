-- Drop existing foreign keys/indexes using issueId
ALTER TABLE "IssueYoutubeIngest" DROP CONSTRAINT IF EXISTS "IssueYoutubeIngest_issueId_fkey";
ALTER TABLE "IssueYoutubeAnalyticsCache" DROP CONSTRAINT IF EXISTS "IssueYoutubeAnalyticsCache_issueId_fkey";

DROP INDEX IF EXISTS "IssueYoutubeIngest_issueId_fetchedAt_idx";
DROP INDEX IF EXISTS "IssueYoutubeAnalyticsCache_issueId_key";

-- Rename relation columns from issueId -> clipIssueId
ALTER TABLE "IssueYoutubeIngest" RENAME COLUMN "issueId" TO "clipIssueId";
ALTER TABLE "IssueYoutubeAnalyticsCache" RENAME COLUMN "issueId" TO "clipIssueId";

-- Recreate indexes/constraints for clipIssue relation
CREATE INDEX "IssueYoutubeIngest_clipIssueId_fetchedAt_idx"
  ON "IssueYoutubeIngest"("clipIssueId", "fetchedAt");

CREATE UNIQUE INDEX "IssueYoutubeAnalyticsCache_clipIssueId_key"
  ON "IssueYoutubeAnalyticsCache"("clipIssueId");

ALTER TABLE "IssueYoutubeIngest"
  ADD CONSTRAINT "IssueYoutubeIngest_clipIssueId_fkey"
  FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueYoutubeAnalyticsCache"
  ADD CONSTRAINT "IssueYoutubeAnalyticsCache_clipIssueId_fkey"
  FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
