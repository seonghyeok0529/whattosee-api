-- CreateTable
CREATE TABLE "RawClipComment" (
    "id" TEXT NOT NULL,
    "rawClipId" TEXT NOT NULL,
    "youtubeCommentId" TEXT NOT NULL,
    "authorChannelId" TEXT,
    "authorName" TEXT,
    "text" TEXT NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "reactionScores" JSONB,
    "reactionLabel" JSONB,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "textHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RawClipComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RawClipComment_youtubeCommentId_key" ON "RawClipComment"("youtubeCommentId");

-- CreateIndex
CREATE INDEX "RawClipComment_rawClipId_idx" ON "RawClipComment"("rawClipId");

-- CreateIndex
CREATE INDEX "RawClipComment_rawClipId_publishedAt_idx" ON "RawClipComment"("rawClipId", "publishedAt");

-- CreateIndex
CREATE INDEX "RawClipComment_rawClipId_likeCount_idx" ON "RawClipComment"("rawClipId", "likeCount");

-- CreateIndex
CREATE INDEX "RawClipComment_authorChannelId_idx" ON "RawClipComment"("authorChannelId");

-- CreateIndex
CREATE INDEX "RawClipComment_textHash_idx" ON "RawClipComment"("textHash");

-- AddForeignKey
ALTER TABLE "RawClipComment" ADD CONSTRAINT "RawClipComment_rawClipId_fkey" FOREIGN KEY ("rawClipId") REFERENCES "RawClip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
