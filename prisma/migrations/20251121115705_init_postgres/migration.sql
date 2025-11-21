-- CreateEnum
CREATE TYPE "SourceSide" AS ENUM ('left', 'center', 'right', 'neutral');

-- CreateEnum
CREATE TYPE "ArticleStatus" AS ENUM ('FETCHED', 'PARSED', 'EMBEDDED', 'CLUSTERED', 'ATTACHED', 'FAILED');

-- CreateEnum
CREATE TYPE "ParentType" AS ENUM ('issue', 'agenda', 'clipIssue');

-- CreateEnum
CREATE TYPE "Stance" AS ENUM ('agree', 'neutral', 'disagree');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "IssueRelationKind" AS ENUM ('RELATED', 'EPISODE_OF');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('SUGGESTED', 'DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CommunityLounge" AS ENUM ('popular', 'politics', 'society', 'economy', 'international', 'tech', 'culture', 'daily', 'humor');

-- CreateEnum
CREATE TYPE "LinkedIssueType" AS ENUM ('article', 'clip');

-- CreateEnum
CREATE TYPE "ClusterSuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'MERGED', 'SPLIT');

-- CreateEnum
CREATE TYPE "ClipClusterStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "username" TEXT,
    "nickname" TEXT,
    "kakaoId" TEXT,
    "naverId" TEXT,
    "googleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bio" TEXT,
    "interests" JSONB,
    "tosAgreedAt" TIMESTAMP(3),
    "privacyAgreedAt" TIMESTAMP(3),
    "marketingAgreed" BOOLEAN DEFAULT false,
    "ctiType" TEXT,
    "ctiScores" JSONB,
    "role" "Role" NOT NULL DEFAULT 'user',
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageView" (
    "id" TEXT NOT NULL,
    "parentType" "ParentType" NOT NULL,
    "parentId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "dayKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleViewLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "side" "SourceSide" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleViewLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agenda" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" JSONB,
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "bestCommentId" TEXT,

    CONSTRAINT "Agenda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgendaComment" (
    "id" TEXT NOT NULL,
    "agendaId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "reportedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AgendaComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgendaLike" (
    "userId" TEXT NOT NULL,
    "agendaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgendaLike_pkey" PRIMARY KEY ("userId","agendaId")
);

-- CreateTable
CREATE TABLE "CommentLike" (
    "userId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agendaId" TEXT,

    CONSTRAINT "CommentLike_pkey" PRIMARY KEY ("userId","commentId")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftSummary" TEXT,
    "rightSummary" TEXT,
    "dedupKey" TEXT,
    "body" TEXT,
    "status" "IssueStatus" NOT NULL DEFAULT 'SUGGESTED',

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueRelation" (
    "id" TEXT NOT NULL,
    "fromIssueId" TEXT NOT NULL,
    "toIssueId" TEXT NOT NULL,
    "relationType" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueComment" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "userId" TEXT,
    "content" TEXT NOT NULL,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "reportedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IssueComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueCommentLike" (
    "userId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueCommentLike_pkey" PRIMARY KEY ("userId","commentId")
);

-- CreateTable
CREATE TABLE "CommentReport" (
    "id" TEXT NOT NULL,
    "parentType" "ParentType" NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "outlet" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "side" "SourceSide" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonRef" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,

    CONSTRAINT "PersonRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawArticle" (
    "id" TEXT NOT NULL,
    "outlet" TEXT NOT NULL,
    "side" "SourceSide" NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "html" TEXT,
    "text" TEXT,
    "hash" TEXT NOT NULL,
    "embedding" BYTEA,
    "status" "ArticleStatus" NOT NULL DEFAULT 'FETCHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clusterKey" TEXT,

    CONSTRAINT "RawArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vote" (
    "id" TEXT NOT NULL,
    "parentType" "ParentType" NOT NULL,
    "parentId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "ctiType" TEXT,
    "stance" "Stance" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterSuggestion" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "status" "ClusterSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "issueId" TEXT,
    "articlesCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClusterSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterSuggestionArticle" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "rawArticleId" TEXT,
    "sourceId" TEXT,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "outlet" TEXT,
    "side" "SourceSide",
    "publishedAt" TIMESTAMP(3),
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClusterSuggestionArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterDecisionLog" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClusterDecisionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawClip" (
    "id" TEXT NOT NULL,
    "youtubeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "channel" TEXT NOT NULL,
    "side" "SourceSide" NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnail" TEXT,
    "publishedAt" TIMESTAMP(3),
    "text" TEXT,
    "embedding" BYTEA,
    "status" "ArticleStatus" NOT NULL DEFAULT 'FETCHED',
    "clusterKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "duration" TEXT,

    CONSTRAINT "RawClip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipClusterSuggestion" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "status" "ClipClusterStatus" NOT NULL DEFAULT 'PENDING',
    "clipIssueId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClipClusterSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipClusterSuggestionItem" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "rawClipId" TEXT,
    "youtubeId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "channel" TEXT,
    "side" "SourceSide",
    "publishedAt" TIMESTAMP(3),
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipClusterSuggestionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipIssue" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "thumbnail" TEXT,
    "isHot" BOOLEAN NOT NULL DEFAULT false,
    "aiSummary" TEXT,
    "progressiveSummary" TEXT,
    "conservativeSummary" TEXT,
    "clipCount" INTEGER NOT NULL DEFAULT 0,
    "totalViews" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClipIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipIssueComment" (
    "id" TEXT NOT NULL,
    "clipIssueId" TEXT NOT NULL,
    "userId" TEXT,
    "content" TEXT NOT NULL,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "reportedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ClipIssueComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipIssueCommentLike" (
    "userId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipIssueCommentLike_pkey" PRIMARY KEY ("userId","commentId")
);

-- CreateTable
CREATE TABLE "ClipIssueClip" (
    "id" TEXT NOT NULL,
    "clipIssueId" TEXT NOT NULL,
    "rawClipId" TEXT NOT NULL,
    "side" "SourceSide" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipIssueClip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsClipViewLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clipIssueId" TEXT,
    "rawClipId" TEXT,
    "group" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsClipViewLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityPost" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lounge" "CommunityLounge" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "thumbnail" TEXT,
    "images" JSONB,
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "viewsCount" INTEGER NOT NULL DEFAULT 0,
    "isHot" BOOLEAN NOT NULL DEFAULT false,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityPostComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT,
    "content" TEXT NOT NULL,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CommunityPostComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityPostIssueLink" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "kind" "LinkedIssueType" NOT NULL,
    "issueId" TEXT,
    "clipIssueId" TEXT,

    CONSTRAINT "CommunityPostIssueLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityPostPoll" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "CommunityPostPoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityPostPollVote" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "optionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityPostPollVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityPostLike" (
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityPostLike_pkey" PRIMARY KEY ("userId","postId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_kakaoId_key" ON "User"("kakaoId");

-- CreateIndex
CREATE UNIQUE INDEX "User_naverId_key" ON "User"("naverId");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PageView_parentType_parentId_dayKey_idx" ON "PageView"("parentType", "parentId", "dayKey");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_view_per_day_by_session" ON "PageView"("parentType", "parentId", "sessionId", "dayKey");

-- CreateIndex
CREATE INDEX "ArticleViewLog_userId_idx" ON "ArticleViewLog"("userId");

-- CreateIndex
CREATE INDEX "ArticleViewLog_sourceId_idx" ON "ArticleViewLog"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Agenda_bestCommentId_key" ON "Agenda"("bestCommentId");

-- CreateIndex
CREATE INDEX "Agenda_title_idx" ON "Agenda"("title");

-- CreateIndex
CREATE INDEX "Agenda_createdAt_idx" ON "Agenda"("createdAt");

-- CreateIndex
CREATE INDEX "Agenda_likesCount_commentCount_idx" ON "Agenda"("likesCount", "commentCount");

-- CreateIndex
CREATE INDEX "AgendaLike_agendaId_idx" ON "AgendaLike"("agendaId");

-- CreateIndex
CREATE INDEX "CommentLike_commentId_idx" ON "CommentLike"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_dedupKey_key" ON "Issue"("dedupKey");

-- CreateIndex
CREATE INDEX "IssueRelation_toIssueId_idx" ON "IssueRelation"("toIssueId");

-- CreateIndex
CREATE UNIQUE INDEX "IssueRelation_fromIssueId_toIssueId_key" ON "IssueRelation"("fromIssueId", "toIssueId");

-- CreateIndex
CREATE INDEX "IssueComment_issueId_createdAt_idx" ON "IssueComment"("issueId", "createdAt");

-- CreateIndex
CREATE INDEX "IssueCommentLike_commentId_idx" ON "IssueCommentLike"("commentId");

-- CreateIndex
CREATE INDEX "CommentReport_parentType_commentId_idx" ON "CommentReport"("parentType", "commentId");

-- CreateIndex
CREATE UNIQUE INDEX "CommentReport_parentType_commentId_userId_key" ON "CommentReport"("parentType", "commentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Source_url_key" ON "Source"("url");

-- CreateIndex
CREATE UNIQUE INDEX "RawArticle_url_key" ON "RawArticle"("url");

-- CreateIndex
CREATE INDEX "RawArticle_status_idx" ON "RawArticle"("status");

-- CreateIndex
CREATE INDEX "RawArticle_clusterKey_idx" ON "RawArticle"("clusterKey");

-- CreateIndex
CREATE INDEX "Vote_parentType_parentId_idx" ON "Vote"("parentType", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Vote_parentType_parentId_userId_key" ON "Vote"("parentType", "parentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Vote_parentType_parentId_sessionId_key" ON "Vote"("parentType", "parentId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ClusterSuggestion_key_key" ON "ClusterSuggestion"("key");

-- CreateIndex
CREATE INDEX "ClusterSuggestion_status_createdAt_idx" ON "ClusterSuggestion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ClusterSuggestion_issueId_idx" ON "ClusterSuggestion"("issueId");

-- CreateIndex
CREATE INDEX "ClusterSuggestionArticle_rawArticleId_idx" ON "ClusterSuggestionArticle"("rawArticleId");

-- CreateIndex
CREATE INDEX "ClusterSuggestionArticle_sourceId_idx" ON "ClusterSuggestionArticle"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ClusterSuggestionArticle_suggestionId_url_key" ON "ClusterSuggestionArticle"("suggestionId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "RawClip_youtubeId_key" ON "RawClip"("youtubeId");

-- CreateIndex
CREATE UNIQUE INDEX "RawClip_url_key" ON "RawClip"("url");

-- CreateIndex
CREATE INDEX "RawClip_status_idx" ON "RawClip"("status");

-- CreateIndex
CREATE INDEX "RawClip_clusterKey_idx" ON "RawClip"("clusterKey");

-- CreateIndex
CREATE UNIQUE INDEX "ClipClusterSuggestion_key_key" ON "ClipClusterSuggestion"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ClipClusterSuggestion_clipIssueId_key" ON "ClipClusterSuggestion"("clipIssueId");

-- CreateIndex
CREATE UNIQUE INDEX "ClipClusterSuggestionItem_suggestionId_youtubeId_key" ON "ClipClusterSuggestionItem"("suggestionId", "youtubeId");

-- CreateIndex
CREATE INDEX "ClipIssueComment_clipIssueId_createdAt_idx" ON "ClipIssueComment"("clipIssueId", "createdAt");

-- CreateIndex
CREATE INDEX "ClipIssueCommentLike_commentId_idx" ON "ClipIssueCommentLike"("commentId");

-- CreateIndex
CREATE INDEX "ClipIssueClip_rawClipId_idx" ON "ClipIssueClip"("rawClipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClipIssueClip_clipIssueId_rawClipId_key" ON "ClipIssueClip"("clipIssueId", "rawClipId");

-- CreateIndex
CREATE INDEX "NewsClipViewLog_userId_idx" ON "NewsClipViewLog"("userId");

-- CreateIndex
CREATE INDEX "NewsClipViewLog_clipIssueId_idx" ON "NewsClipViewLog"("clipIssueId");

-- CreateIndex
CREATE INDEX "NewsClipViewLog_rawClipId_idx" ON "NewsClipViewLog"("rawClipId");

-- CreateIndex
CREATE INDEX "CommunityPost_lounge_createdAt_idx" ON "CommunityPost"("lounge", "createdAt");

-- CreateIndex
CREATE INDEX "CommunityPost_lounge_likesCount_commentCount_idx" ON "CommunityPost"("lounge", "likesCount", "commentCount");

-- CreateIndex
CREATE INDEX "CommunityPostComment_postId_createdAt_idx" ON "CommunityPostComment"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "CommunityPostIssueLink_postId_idx" ON "CommunityPostIssueLink"("postId");

-- CreateIndex
CREATE INDEX "CommunityPostIssueLink_issueId_idx" ON "CommunityPostIssueLink"("issueId");

-- CreateIndex
CREATE INDEX "CommunityPostIssueLink_clipIssueId_idx" ON "CommunityPostIssueLink"("clipIssueId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityPostPoll_postId_key" ON "CommunityPostPoll"("postId");

-- CreateIndex
CREATE INDEX "CommunityPostPollVote_pollId_idx" ON "CommunityPostPollVote"("pollId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityPostPollVote_pollId_userId_key" ON "CommunityPostPollVote"("pollId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityPostPollVote_pollId_sessionId_key" ON "CommunityPostPollVote"("pollId", "sessionId");

-- CreateIndex
CREATE INDEX "CommunityPostLike_postId_idx" ON "CommunityPostLike"("postId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleViewLog" ADD CONSTRAINT "ArticleViewLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleViewLog" ADD CONSTRAINT "ArticleViewLog_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agenda" ADD CONSTRAINT "Agenda_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agenda" ADD CONSTRAINT "Agenda_bestCommentId_fkey" FOREIGN KEY ("bestCommentId") REFERENCES "AgendaComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgendaComment" ADD CONSTRAINT "AgendaComment_agendaId_fkey" FOREIGN KEY ("agendaId") REFERENCES "Agenda"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgendaComment" ADD CONSTRAINT "AgendaComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgendaLike" ADD CONSTRAINT "AgendaLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgendaLike" ADD CONSTRAINT "AgendaLike_agendaId_fkey" FOREIGN KEY ("agendaId") REFERENCES "Agenda"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentLike" ADD CONSTRAINT "CommentLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentLike" ADD CONSTRAINT "CommentLike_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "AgendaComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentLike" ADD CONSTRAINT "CommentLike_agendaId_fkey" FOREIGN KEY ("agendaId") REFERENCES "Agenda"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueRelation" ADD CONSTRAINT "IssueRelation_fromIssueId_fkey" FOREIGN KEY ("fromIssueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueRelation" ADD CONSTRAINT "IssueRelation_toIssueId_fkey" FOREIGN KEY ("toIssueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueComment" ADD CONSTRAINT "IssueComment_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueComment" ADD CONSTRAINT "IssueComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueCommentLike" ADD CONSTRAINT "IssueCommentLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueCommentLike" ADD CONSTRAINT "IssueCommentLike_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "IssueComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonRef" ADD CONSTRAINT "PersonRef_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterSuggestion" ADD CONSTRAINT "ClusterSuggestion_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterSuggestionArticle" ADD CONSTRAINT "ClusterSuggestionArticle_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "ClusterSuggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterSuggestionArticle" ADD CONSTRAINT "ClusterSuggestionArticle_rawArticleId_fkey" FOREIGN KEY ("rawArticleId") REFERENCES "RawArticle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterSuggestionArticle" ADD CONSTRAINT "ClusterSuggestionArticle_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterDecisionLog" ADD CONSTRAINT "ClusterDecisionLog_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "ClusterSuggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipClusterSuggestion" ADD CONSTRAINT "ClipClusterSuggestion_clipIssueId_fkey" FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipClusterSuggestionItem" ADD CONSTRAINT "ClipClusterSuggestionItem_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "ClipClusterSuggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipClusterSuggestionItem" ADD CONSTRAINT "ClipClusterSuggestionItem_rawClipId_fkey" FOREIGN KEY ("rawClipId") REFERENCES "RawClip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipIssueComment" ADD CONSTRAINT "ClipIssueComment_clipIssueId_fkey" FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipIssueComment" ADD CONSTRAINT "ClipIssueComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipIssueCommentLike" ADD CONSTRAINT "ClipIssueCommentLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipIssueCommentLike" ADD CONSTRAINT "ClipIssueCommentLike_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "ClipIssueComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipIssueClip" ADD CONSTRAINT "ClipIssueClip_clipIssueId_fkey" FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipIssueClip" ADD CONSTRAINT "ClipIssueClip_rawClipId_fkey" FOREIGN KEY ("rawClipId") REFERENCES "RawClip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsClipViewLog" ADD CONSTRAINT "NewsClipViewLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsClipViewLog" ADD CONSTRAINT "NewsClipViewLog_clipIssueId_fkey" FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsClipViewLog" ADD CONSTRAINT "NewsClipViewLog_rawClipId_fkey" FOREIGN KEY ("rawClipId") REFERENCES "RawClip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPost" ADD CONSTRAINT "CommunityPost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPostComment" ADD CONSTRAINT "CommunityPostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CommunityPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPostComment" ADD CONSTRAINT "CommunityPostComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPostIssueLink" ADD CONSTRAINT "CommunityPostIssueLink_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CommunityPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPostIssueLink" ADD CONSTRAINT "CommunityPostIssueLink_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPostIssueLink" ADD CONSTRAINT "CommunityPostIssueLink_clipIssueId_fkey" FOREIGN KEY ("clipIssueId") REFERENCES "ClipIssue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPostPoll" ADD CONSTRAINT "CommunityPostPoll_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CommunityPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPostPollVote" ADD CONSTRAINT "CommunityPostPollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "CommunityPostPoll"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPostLike" ADD CONSTRAINT "CommunityPostLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPostLike" ADD CONSTRAINT "CommunityPostLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CommunityPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
