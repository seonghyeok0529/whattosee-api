//commntes.ts

import { Router } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth";
import type { Request } from "express";
import type { Prisma } from '@prisma/client';


interface AuthRequest extends Request { userId?: string }

export const commentsRouter = Router();

// GET /api/comments?parentType=issue|agenda&parentId=...
commentsRouter.get("/", async (req, res) => {
  const { parentType = "issue", parentId = "i1" } = req.query as any;
  res.json({
    items: [
      { id: "c1", userId: "u1", body: `${parentType}:${parentId} 댓글 예시`, sentiment: "neutral", createdAt: new Date().toISOString() }
    ]
  });
});

// POST /api/comments/:id/like  (토글)
commentsRouter.post("/:id/like", requireAuth as any, async (req: AuthRequest, res) => {
    try {
      if (!req.userId) return res.status(401).json({ error: "UNAUTHORIZED" });
      const commentId = req.params.id;
  
      const cmt = await prisma.agendaComment.findUnique({
        where: { id: commentId },
        select: { id: true },
      });
      if (!cmt) return res.status(404).json({ error: "NOT_FOUND" });
  
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const existing = await tx.commentLike.findUnique({
          where: { userId_commentId: { userId: req.userId!, commentId } },
        });
  
        if (existing) {
          await tx.commentLike.delete({
            where: { userId_commentId: { userId: req.userId!, commentId } },
          });
          const updated = await tx.agendaComment.update({
            where: { id: commentId },
            data: { likes: { decrement: 1 } },
            select: { likes: true },
          });
          return { liked: false, count: updated.likes };
        } else {
          await tx.commentLike.create({
            data: { userId: req.userId!, commentId },
          });
          const updated = await tx.agendaComment.update({
            where: { id: commentId },
            data: { likes: { increment: 1 } },
            select: { likes: true },
          });
          return { liked: true, count: updated.likes };
        }
      });
  
      return res.json(result);
    } catch (e) {
      console.error("[POST /api/comments/:id/like] error:", e);
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

export default commentsRouter;
