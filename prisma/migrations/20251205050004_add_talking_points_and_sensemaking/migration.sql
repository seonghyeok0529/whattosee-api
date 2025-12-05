-- CreateTable
CREATE TABLE "IssueTalkingPoint" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueTalkingPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipIssueTalkingPoint" (
    "id" TEXT NOT NULL,
    "clipIssueId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClipIssueTalkingPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueSensemaking" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "importance" INTEGER NOT NULL,
    "impactAreas" TEXT[],
    "difficultyLevel" TEXT,
    "whyImportant" TEXT NOT NULL,
    "everydayImpact" TEXT,
    "keyQuestions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueSensemaking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipIssueSensemaking" (
    "id" TEXT NOT NULL,
    "clipIssueId" TEXT NOT NULL,
    "importance" INTEGER NOT NULL,
    "impactAreas" TEXT[],
    "difficultyLevel" TEXT,
    "whyImportant" TEXT NOT NULL,
    "everydayImpact" TEXT,
    "keyQuestions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClipIssueSensemaking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IssueTalkingPoint_issueId_order_idx" ON "IssueTalkingPoint"("issueId", "order");

-- CreateIndex
CREATE INDEX "ClipIssueTalkingPoint_clipIssueId_order_idx" ON "ClipIssueTalkingPoint"("clipIssueId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "IssueSensemaking_issueId_key" ON "IssueSensemaking"("issueId");

-- CreateIndex
CREATE UNIQUE INDEX "ClipIssueSensemaking_clipIssueId_key" ON "ClipIssueSensemaking"("clipIssueId");

-- AddForeignKey
ALTER TABLE "IssueTalkingPoint" ADD CONSTRAINT "IssueTalkingPoint_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipIssueTalkingPoint" ADD CONSTRAINT "ClipIssueTalkingPoint_clipIssueId_fkey" FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueSensemaking" ADD CONSTRAINT "IssueSensemaking_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipIssueSensemaking" ADD CONSTRAINT "ClipIssueSensemaking_clipIssueId_fkey" FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
