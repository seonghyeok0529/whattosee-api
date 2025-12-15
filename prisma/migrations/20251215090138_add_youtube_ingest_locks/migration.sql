-- CreateTable
CREATE TABLE "JobLock" (
    "key" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "runId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobLock_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "YoutubeChannelCursor" (
    "channelId" TEXT NOT NULL,
    "lastPublishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YoutubeChannelCursor_pkey" PRIMARY KEY ("channelId")
);

-- CreateIndex
CREATE INDEX "JobLock_lockedUntil_idx" ON "JobLock"("lockedUntil");

-- CreateIndex
CREATE INDEX "YoutubeChannelCursor_lastPublishedAt_idx" ON "YoutubeChannelCursor"("lastPublishedAt");
