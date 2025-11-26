-- CreateTable 
CREATE TABLE "ClipIssueRelation" (
    "id" TEXT NOT NULL,
    "fromClipIssueId" TEXT NOT NULL,
    "toClipIssueId" TEXT NOT NULL,
    "relationType" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipIssueRelation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClipIssueRelation_toClipIssueId_idx" ON "ClipIssueRelation"("toClipIssueId");

-- CreateIndex
CREATE UNIQUE INDEX "ClipIssueRelation_fromClipIssueId_toClipIssueId_key" ON "ClipIssueRelation"("fromClipIssueId", "toClipIssueId");

-- AddForeignKey
ALTER TABLE "ClipIssueRelation" ADD CONSTRAINT "ClipIssueRelation_fromClipIssueId_fkey" FOREIGN KEY ("fromClipIssueId") REFERENCES "ClipIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipIssueRelation" ADD CONSTRAINT "ClipIssueRelation_toClipIssueId_fkey" FOREIGN KEY ("toClipIssueId") REFERENCES "ClipIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
