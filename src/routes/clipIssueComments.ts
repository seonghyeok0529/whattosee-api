import { Router, type Response } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { ParentType } from "@prisma/client";

const clipIssueCommentsRouter = Router();

/** 공통 매핑: nickname → username → '익명' */
function mapClipIssueComment(c: any) {
  const nickname = c.user?.nickname ?? null;
  const username = c.user?.username ?? null;

  return {
    id: c.id,
    clipIssueId: c.clipIssueId,
    content: c.content,
    createdAt: c.createdAt,
    likes: c.likes,
    reportedCount: c.reportedCount,
    isDeleted: c.isDeleted,
    authorId: c.user?.id ?? null,
    authorName: nickname || username || "익명",
    user: c.user
      ? {
          id: c.user.id,
          username: c.user.username,
          nickname: c.user.nickname ?? null,
        }
      : null,
  };
}

/**
 * GET /api/clip-issues/:id/comments
 * 특정 클립 이슈의 댓글 목록
 */
clipIssueCommentsRouter.get(
  "/clip-issues/:id/comments",
  async (req, res: Response) => {
    const { id } = req.params;

    const rows = await prisma.clipIssueComment.findMany({
      where: { clipIssueId: id, isDeleted: false },
      orderBy: { createdAt: "asc" },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            nickname: true, // 🔥 닉네임 추가
          },
        },
      },
    });

    const items = rows.map(mapClipIssueComment);
    return res.json({ items });
  }
);

/**
 * POST /api/clip-issues/:id/comments
 * 댓글 작성 (로그인 필요)
 */
clipIssueCommentsRouter.post(
  "/clip-issues/:id/comments",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const { id } = req.params;
    const { content } = req.body;
    const userId = req.userId ?? req.user?.id ?? null;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: "EMPTY_CONTENT" });
    }

    const c = await prisma.clipIssueComment.create({
      data: {
        clipIssueId: id,
        content: content.trim(),
        userId: userId || undefined, // nullable 허용
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            nickname: true, // 🔥 닉네임 추가
          },
        },
      },
    });

    const comment = mapClipIssueComment(c);
    return res.status(201).json(comment);
  }
);

/**
 * POST /api/clip-issues/comments/:commentId/like
 * 댓글 좋아요 토글 (로그인 필요)
 */
clipIssueCommentsRouter.post(
  "/clip-issues/comments/:commentId/like",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const { commentId } = req.params;
    const userId = req.userId ?? req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const existing = await prisma.clipIssueCommentLike.findUnique({
      where: {
        userId_commentId: { userId, commentId },
      },
    });

    if (existing) {
      // UNLIKE
      await prisma.$transaction([
        prisma.clipIssueCommentLike.delete({
          where: {
            userId_commentId: { userId, commentId },
          },
        }),
        prisma.clipIssueComment.update({
          where: { id: commentId },
          data: { likes: { decrement: 1 } },
        }),
      ]);

      return res.json({ status: "UNLIKED" });
    }

    // LIKE
    await prisma.$transaction([
      prisma.clipIssueCommentLike.create({
        data: { userId, commentId },
      }),
      prisma.clipIssueComment.update({
        where: { id: commentId },
        data: { likes: { increment: 1 } },
      }),
    ]);

    return res.json({ status: "LIKED" });
  }
);

/**
 * DELETE /api/clip-issues/comments/:commentId
 * 댓글 삭제(soft delete) – 본인 또는 관리자만
 */
clipIssueCommentsRouter.delete(
  "/clip-issues/comments/:commentId",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const { commentId } = req.params;
    const userId = req.userId ?? req.user?.id;
    const isAdmin = !!req.user?.isAdmin;

    if (!userId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const comment = await prisma.clipIssueComment.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        userId: true,
        isDeleted: true,
      },
    });

    if (!comment || comment.isDeleted) {
      return res.status(404).json({ error: "NOT_FOUND" });
    }

    if (comment.userId !== userId && !isAdmin) {
      return res.status(403).json({ error: "FORBIDDEN" });
    }

    await prisma.clipIssueComment.update({
      where: { id: commentId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
      },
    });

    return res.json({ status: "DELETED" });
  }
);

/**
 * POST /api/clip-issues/comments/:commentId/report
 * 댓글 신고 (로그인 필요)
 * CommentReport + reportedCount 증가
 */
clipIssueCommentsRouter.post(
  "/clip-issues/comments/:commentId/report",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const { commentId } = req.params;
    const { reason } = req.body;
    const userId = req.userId ?? req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const comment = await prisma.clipIssueComment.findUnique({
      where: { id: commentId },
      select: { id: true, isDeleted: true },
    });

    if (!comment || comment.isDeleted) {
      return res.status(404).json({ error: "NOT_FOUND" });
    }

    try {
      await prisma.$transaction([
        prisma.commentReport.create({
          data: {
            parentType: ParentType.issue, // 기존 이슈 댓글과 동일한 parentType 사용
            commentId,
            userId,
            reason: reason?.toString().slice(0, 500) ?? null,
          },
        }),
        prisma.clipIssueComment.update({
          where: { id: commentId },
          data: {
            reportedCount: { increment: 1 },
          },
        }),
      ]);
    } catch (err: any) {
      // 유니크 제약(이미 신고한 경우) 대비
      if (err.code === "P2002") {
        return res.status(400).json({ error: "ALREADY_REPORTED" });
      }
      console.error("[clip-issue-comment-report] error:", err);
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }

    return res.json({ status: "REPORTED" });
  }
);

export default clipIssueCommentsRouter;
