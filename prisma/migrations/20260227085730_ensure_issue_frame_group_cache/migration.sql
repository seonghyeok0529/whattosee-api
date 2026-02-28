CREATE TABLE IF NOT EXISTS "IssueFrameGroupCache" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "articleCount" INTEGER NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueFrameGroupCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IssueFrameGroupCache_issueId_key" ON "IssueFrameGroupCache"("issueId");
CREATE INDEX IF NOT EXISTS "IssueFrameGroupCache_expiresAt_idx" ON "IssueFrameGroupCache"("expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'IssueFrameGroupCache_issueId_fkey'
  ) THEN
    ALTER TABLE "IssueFrameGroupCache"
      ADD CONSTRAINT "IssueFrameGroupCache_issueId_fkey"
      FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
