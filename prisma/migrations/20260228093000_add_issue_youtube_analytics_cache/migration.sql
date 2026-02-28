-- CreateTable
CREATE TABLE "IssueYoutubeIngest" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "params" JSONB NOT NULL,
    "videoCount" INTEGER NOT NULL,
    "commentCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueYoutubeIngest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueYoutubeAnalyticsCache" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueYoutubeAnalyticsCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IssueYoutubeIngest_issueId_fetchedAt_idx" ON "IssueYoutubeIngest"("issueId", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IssueYoutubeAnalyticsCache_issueId_key" ON "IssueYoutubeAnalyticsCache"("issueId");

-- CreateIndex
CREATE INDEX "IssueYoutubeAnalyticsCache_expiresAt_idx" ON "IssueYoutubeAnalyticsCache"("expiresAt");

-- AddForeignKey
ALTER TABLE "IssueYoutubeIngest" ADD CONSTRAINT "IssueYoutubeIngest_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueYoutubeAnalyticsCache" ADD CONSTRAINT "IssueYoutubeAnalyticsCache_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
