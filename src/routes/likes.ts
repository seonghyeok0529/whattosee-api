// src/routes/likes.ts
import { Router } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth";
import type { Prisma } from "@prisma/client";

export const likesRouter = Router();

/**
 * POST /api/likes/toggle
 * body: { parentType: 'agenda' | 'comment', parentId: string }
 * return: { isLiked: boolean, count: number }
 */
likesRouter.post("/toggle", requireAuth as any, async (req: any, res) => {
  try {
    const userId = req.userId as string | undefined;
    if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

    const { parentType, parentId } = req.body ?? {};
    if (parentType !== "agenda" && parentType !== "comment")
      return res.status(400).json({ error: "INVALID_PARENT_TYPE" });
    if (!parentId) return res.status(400).json({ error: "INVALID_PARENT_ID" });

    // 1) 아젠다 좋아요
    if (parentType === "agenda") {
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const exists = await tx.agendaLike.findUnique({
          where: { userId_agendaId: { userId, agendaId: parentId } },
        });

        if (exists) {
          await tx.agendaLike.delete({
            where: { userId_agendaId: { userId, agendaId: parentId } },
          });
          const updated = await tx.agenda.update({
            where: { id: parentId },
            data: { likesCount: { decrement: 1 } },
            select: { likesCount: true },
          });
          return { isLiked: false, count: Math.max(0, updated.likesCount) };
        } else {
          await tx.agendaLike.create({ data: { userId, agendaId: parentId } });
          const updated = await tx.agenda.update({
            where: { id: parentId },
            data: { likesCount: { increment: 1 } },
            select: { likesCount: true },
          });
          return { isLiked: true, count: updated.likesCount };
        }
      });

      return res.json(result);
    }

    // 2) 댓글 좋아요 (아젠다 댓글 or 이슈 댓글 자동 판별)
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 먼저 AgendaComment 인지 확인
      const agendaComment = await tx.agendaComment.findUnique({
        where: { id: parentId },
        select: { id: true },
      });

      if (agendaComment) {
        const exists = await tx.commentLike.findUnique({
          where: { userId_commentId: { userId, commentId: parentId } },
        });

        if (exists) {
          await tx.commentLike.delete({
            where: { userId_commentId: { userId, commentId: parentId } },
          });
          const updated = await tx.agendaComment.update({
            where: { id: parentId },
            data: { likes: { decrement: 1 } },
            select: { likes: true },
          });
          return { isLiked: false, count: Math.max(0, updated.likes) };
        } else {
          await tx.commentLike.create({ data: { userId, commentId: parentId } });
          const updated = await tx.agendaComment.update({
            where: { id: parentId },
            data: { likes: { increment: 1 } },
            select: { likes: true },
          });
          return { isLiked: true, count: updated.likes };
        }
      }

      // 아니면 IssueComment 인지 확인
      const issueComment = await tx.issueComment.findUnique({
        where: { id: parentId },
        select: { id: true },
      });

      if (issueComment) {
        const exists = await tx.issueCommentLike.findUnique({
          where: { userId_commentId: { userId, commentId: parentId } },
        });

        if (exists) {
          await tx.issueCommentLike.delete({
            where: { userId_commentId: { userId, commentId: parentId } },
          });
          const updated = await tx.issueComment.update({
            where: { id: parentId },
            data: { likes: { decrement: 1 } },
            select: { likes: true },
          });
          return { isLiked: false, count: Math.max(0, updated.likes) };
        } else {
          await tx.issueCommentLike.create({ data: { userId, commentId: parentId } });
          const updated = await tx.issueComment.update({
            where: { id: parentId },
            data: { likes: { increment: 1 } },
            select: { likes: true },
          });
          return { isLiked: true, count: updated.likes };
        }
      }

      // 둘 다 없으면 404
      return res.status(404).json({ error: "COMMENT_NOT_FOUND" });
    });

    // 트랜잭션에서 바로 res.json 했을 수 있으므로 방어
    if (!res.headersSent) return res.json(result);
  } catch (e) {
    console.error("[POST /likes/toggle] error:", e);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/likes/status?parentType=agenda|comment&parentId=...
 * return: { isLiked: boolean, count: number }
 */
likesRouter.get("/status", requireAuth as any, async (req: any, res) => {
  try {
    const userId = req.userId as string | undefined;
    if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

    const parentType = String(req.query.parentType || "");
    const parentId = String(req.query.parentId || "");
    if (!parentId) return res.status(400).json({ error: "INVALID_PARENT_ID" });

    if (parentType === "agenda") {
      const [ag, mine] = await Promise.all([
        prisma.agenda.findUnique({ where: { id: parentId }, select: { likesCount: true } }),
        prisma.agendaLike.findUnique({ where: { userId_agendaId: { userId, agendaId: parentId } } }),
      ]);
      if (!ag) return res.status(404).json({ error: "NOT_FOUND" });
      return res.json({ isLiked: !!mine, count: ag.likesCount });
    }

    if (parentType === "comment") {
      // 아젠다 댓글부터 확인
      const agendaComment = await prisma.agendaComment.findUnique({
        where: { id: parentId },
        select: { id: true, likes: true },
      });
      if (agendaComment) {
        const mine = await prisma.commentLike.findUnique({
          where: { userId_commentId: { userId, commentId: parentId } },
        });
        return res.json({ isLiked: !!mine, count: agendaComment.likes });
      }

      // 이슈 댓글 확인
      const issueComment = await prisma.issueComment.findUnique({
        where: { id: parentId },
        select: { id: true, likes: true },
      });
      if (issueComment) {
        const mine = await prisma.issueCommentLike.findUnique({
          where: { userId_commentId: { userId, commentId: parentId } },
        });
        return res.json({ isLiked: !!mine, count: issueComment.likes });
      }

      return res.status(404).json({ error: "NOT_FOUND" });
    }

    return res.status(400).json({ error: "INVALID_PARENT_TYPE" });
  } catch (e) {
    console.error("[GET /likes/status] error:", e);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

export default likesRouter;
