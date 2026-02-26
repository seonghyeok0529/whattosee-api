-- CreateTable
CREATE TABLE "IssueFrameGroupCache" (
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

-- CreateIndex
CREATE UNIQUE INDEX "IssueFrameGroupCache_issueId_key" ON "IssueFrameGroupCache"("issueId");

-- CreateIndex
CREATE INDEX "IssueFrameGroupCache_expiresAt_idx" ON "IssueFrameGroupCache"("expiresAt");

-- AddForeignKey
ALTER TABLE "IssueFrameGroupCache" ADD CONSTRAINT "IssueFrameGroupCache_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
