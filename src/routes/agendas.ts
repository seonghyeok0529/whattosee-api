// src/routes/agendas.ts
import { Router, type Request } from "express";
import prisma from "../lib/prisma.js";        // ESM 빌드 후 .js 경로, ts-node면 .ts 허용
import { requireAuth } from "../middleware/requireAuth";
import type { Prisma } from "@prisma/client";

interface AuthRequest extends Request {
  userId?: string; // requireAuth에서 주입
}

export const agendasRouter = Router();

/* -------------------- 공통 select -------------------- */
const selectAgenda = {
  id: true,
  title: true,
  content: true,
  tags: true,             // Prisma Json (string[])
  likesCount: true,
  commentCount: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      username: true,
      nickname: true,   // 🔥 닉네임 추가
      ctiType: true,
    },
  },
} as const;

/* -------------------- 유틸 -------------------- */

type SelectedComment = {
  id: string;
  content: string;
  likes: number;
  createdAt: Date;
  user: {
    id: string;
    username: string | null;
    nickname: string | null;
    ctiType: string | null;
  } | null;
};

type CommentDTO = {
  id: string;
  content: string;
  likes: number;
  createdAt: Date;
  user: {
    id: string;
    username: string | null;
    nickname: string | null;
    ctiType: string | null;
  } | null;
};

function toCommentDTO(c: SelectedComment): CommentDTO {
  return {
    id: c.id,
    content: c.content,
    likes: c.likes,
    createdAt: c.createdAt,
    user: c.user
      ? {
          id: c.user.id,
          username: c.user.username ?? null,
          nickname: c.user.nickname ?? null,
          ctiType: c.user.ctiType ?? null,
        }
      : {
          id: "unknown",
          username: null,
          nickname: null,
          ctiType: null,
        },
  };
}

// Json(any) → string[] 안전 변환
function jsonToStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((x) => typeof x === "string") as string[];
}

// 태그 정제(문자만, trim, 중복 제거, 최대 5개)
function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const cleaned = (tags as unknown[])
    .map((t) => String(t ?? "").trim())
    .filter((t) => t.length > 0);
  return Array.from(new Set(cleaned)).slice(0, 5);
}

// DTO 매퍼 (agenda 본문)
function toDTO(
  a: any,
  overrides: Partial<{ isLiked: boolean }> = {}
) {
  const tags = jsonToStringArray(a.tags);
  return {
    id: a.id as string,
    title: a.title as string,
    content: a.content as string,
    tags,
    likes: a.likesCount as number,
    commentCount: a.commentCount as number,
    createdAt: a.createdAt,
    username: a.user?.username ?? null,
    nickname: a.user?.nickname ?? null,
    authorCTI: a.user?.ctiType ?? null,
    isLiked: overrides.isLiked ?? false,
  };
}



/* -------------------- 실제 API -------------------- */
/** GET /api/agendas?sort=popular|latest */
agendasRouter.get("/", async (req, res) => {
  const sort = (req.query.sort as string) || "popular";
  const orderBy =
    sort === "latest"
      ? [{ createdAt: "desc" as const }]
      : [{ likesCount: "desc" as const }, { createdAt: "desc" as const }];

  const list = await prisma.agenda.findMany({
    orderBy,
    select: selectAgenda,
  });

  res.json({ items: list.map((a) => toDTO(a)) });
});

/** GET /api/agendas/:id  → { agenda, bestComment, comments } */
agendasRouter.get("/:id", async (req, res) => {
  const agendaId = req.params.id;

  const a = await prisma.agenda.findUnique({
    where: { id: agendaId },
    select: selectAgenda,
  });
  if (!a) return res.status(404).json({ error: "NOT_FOUND" });

  // ✅ 현재 로그인 유저 가져오기 (optional)
  const anyReq = req as any;
  const userId: string | undefined = anyReq.userId ?? anyReq.user?.id;

  let isLiked = false;
  if (userId) {
    const like = await prisma.agendaLike.findUnique({
      where: {
        userId_agendaId: {
          userId,
          agendaId,
        },
      },
    });
    isLiked = !!like;
  }

  // 베스트 댓글
  const best = await prisma.agendaComment.findFirst({
    where: { agendaId },
    orderBy: [{ likes: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      content: true,
      likes: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          username: true,
          nickname: true,
          ctiType: true,
        },
      },
    },
  });

  const bestComment =
    best && best.likes >= 10 ? toCommentDTO(best as SelectedComment) : null;

  // 일반 댓글 목록 (베스트 제외)
  const comments = await prisma.agendaComment.findMany({
    where: {
      agendaId,
      ...(bestComment ? { NOT: { id: bestComment.id } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      content: true,
      likes: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          username: true,
          nickname: true,
          ctiType: true,
        },
      },
    },
  });

  res.json({
    agenda: toDTO(a, { isLiked }), // ✅ 여기서 isLiked 반영
    bestComment,
    comments: comments.map((c) => toCommentDTO(c as SelectedComment)),
  });
});

// GET /api/agendas/:id/comments  (목록만 따로)
agendasRouter.get("/:id/comments", async (req, res) => {
  const agendaId = req.params.id;

  const exists = await prisma.agenda.findUnique({
    where: { id: agendaId },
    select: { id: true },
  });
  if (!exists) return res.status(404).json({ error: "NOT_FOUND" });

  const comments = await prisma.agendaComment.findMany({
    where: { agendaId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      content: true,
      likes: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          username: true,
          nickname: true, // 🔥 닉네임 추가
          ctiType: true,
        },
      },
    },
  });

  res.json({
    items: comments.map((c) => toCommentDTO(c as SelectedComment)),
  });
});

// POST /api/agendas/:id/comments  (생성)
agendasRouter.post(
  "/:id/comments",
  requireAuth as any,
  async (req: AuthRequest, res) => {
    try {
      if (!req.userId)
        return res.status(401).json({ error: "UNAUTHORIZED" });

      const agendaId = req.params.id;
      const { content } = req.body ?? {};
      if (typeof content !== "string" || !content.trim()) {
        return res.status(400).json({ error: "INVALID_CONTENT" });
      }

      const created = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const ag = await tx.agenda.findUnique({
            where: { id: agendaId },
            select: { id: true },
          });
          if (!ag) throw new Error("AGENDA_NOT_FOUND");

          const c = await tx.agendaComment.create({
            data: {
              agendaId,
              userId: req.userId!,
              content: content.trim(),
            },
            select: {
              id: true,
              content: true,
              likes: true,
              createdAt: true,
              user: {
                select: {
                  id: true,
                  username: true,
                  nickname: true, // 🔥 닉네임 추가
                  ctiType: true,
                },
              },
            },
          });

          await tx.agenda.update({
            where: { id: agendaId },
            data: { commentCount: { increment: 1 } },
          });

          return c;
        }
      );

      return res
        .status(201)
        .json({ comment: toCommentDTO(created as SelectedComment) });
    } catch (e: any) {
      if (e?.message === "AGENDA_NOT_FOUND") {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      console.error("[POST /api/agendas/:id/comments] error:", e);
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

/** POST /api/agendas */
agendasRouter.post("/", requireAuth as any, async (req: AuthRequest, res) => {
  try {
    const { title, content, tags } = req.body ?? {};

    if (!req.userId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "INVALID_TITLE" });
    }
    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "INVALID_CONTENT" });
    }

    const cleanTags = normalizeTags(tags);

    const created = await prisma.agenda.create({
      data: {
        title: title.trim().slice(0, 120),
        content: content.trim(),
        tags: cleanTags as any, // Json(string[])
        user: { connect: { id: req.userId } },
      },
      select: selectAgenda,
    });

    res.status(201).json({ agenda: toDTO(created) });
  } catch (e) {
    console.error("[POST /api/agendas] error:", e);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/** PATCH /api/agendas/:id */
agendasRouter.patch(
  "/:id",
  requireAuth as any,
  async (req: AuthRequest, res) => {
    try {
      if (!req.userId)
        return res.status(401).json({ error: "UNAUTHORIZED" });
      const { title, content, tags } = req.body ?? {};

      const current = await prisma.agenda.findUnique({
        where: { id: req.params.id },
        select: { id: true, userId: true },
      });
      if (!current) return res.status(404).json({ error: "NOT_FOUND" });
      if (current.userId !== req.userId)
        return res.status(403).json({ error: "FORBIDDEN" });

      const data: any = {};
      if (typeof title === "string")
        data.title = title.trim().slice(0, 120);
      if (typeof content === "string") data.content = content.trim();
      if (Array.isArray(tags)) data.tags = normalizeTags(tags) as any;

      const updated = await prisma.agenda.update({
        where: { id: req.params.id },
        data,
        select: selectAgenda,
      });

      res.json({ agenda: toDTO(updated) });
    } catch (e) {
      console.error("[PATCH /api/agendas/:id] error:", e);
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

/** DELETE /api/agendas/:id */
agendasRouter.delete(
  "/:id",
  requireAuth as any,
  async (req: AuthRequest, res) => {
    try {
      if (!req.userId)
        return res.status(401).json({ error: "UNAUTHORIZED" });

      const current = await prisma.agenda.findUnique({
        where: { id: req.params.id },
        select: { id: true, userId: true },
      });
      if (!current) return res.status(404).json({ error: "NOT_FOUND" });
      if (current.userId !== req.userId)
        return res.status(403).json({ error: "FORBIDDEN" });

      await prisma.agenda.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch (e) {
      console.error("[DELETE /api/agendas/:id] error:", e);
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

// POST /api/agendas/:id/like  (토글)
agendasRouter.post(
  "/:id/like",
  requireAuth as any,
  async (req: AuthRequest, res) => {
    try {
      if (!req.userId)
        return res.status(401).json({ error: "UNAUTHORIZED" });
      const agendaId = req.params.id;

      const ag = await prisma.agenda.findUnique({
        where: { id: agendaId },
        select: { id: true },
      });
      if (!ag) return res.status(404).json({ error: "NOT_FOUND" });

      const result = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const existing = await tx.agendaLike.findUnique({
            where: {
              userId_agendaId: { userId: req.userId!, agendaId },
            },
          });

          if (existing) {
            await tx.agendaLike.delete({
              where: {
                userId_agendaId: { userId: req.userId!, agendaId },
              },
            });
            const updated = await tx.agenda.update({
              where: { id: agendaId },
              data: { likesCount: { decrement: 1 } },
              select: { likesCount: true },
            });
            return { liked: false, count: updated.likesCount };
          } else {
            await tx.agendaLike.create({
              data: { userId: req.userId!, agendaId },
            });
            const updated = await tx.agenda.update({
              where: { id: agendaId },
              data: { likesCount: { increment: 1 } },
              select: { likesCount: true },
            });
            return { liked: true, count: updated.likesCount };
          }
        }
      );

      return res.json(result);
    } catch (e) {
      console.error("[POST /api/agendas/:id/like] error:", e);
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

// DELETE /api/agendas/:agendaId/comments/:commentId
agendasRouter.delete(
  "/:agendaId/comments/:commentId",
  requireAuth as any,
  async (req: any, res) => {
    try {
      const { agendaId, commentId } = req.params;
      const userId = req.userId;

      const comment = await prisma.agendaComment.findUnique({
        where: { id: commentId },
        select: {
          id: true,
          agendaId: true,
          userId: true,
          isDeleted: true,
        },
      });
      if (!comment || comment.agendaId !== agendaId) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }
      if (comment.userId !== userId) {
        return res.status(403).json({ error: "FORBIDDEN" });
      }
      if (comment.isDeleted) {
        return res.json({ ok: true });
      }

      await prisma.agendaComment.update({
        where: { id: commentId },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          content: "[삭제된 댓글입니다]",
        },
      });
      return res.json({ ok: true });
    } catch (e) {
      console.error(
        "[DELETE /agendas/:agendaId/comments/:commentId] error:",
        e
      );
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

// POST /api/agendas/:agendaId/comments/:commentId/report
agendasRouter.post(
  "/:agendaId/comments/:commentId/report",
  requireAuth as any,
  async (req: any, res) => {
    try {
      const { agendaId, commentId } = req.params;
      const { reason } = req.body ?? {};
      const userId = req.userId;

      const comment = await prisma.agendaComment.findUnique({
        where: { id: commentId },
        select: { id: true, agendaId: true },
      });
      if (!comment || comment.agendaId !== agendaId) {
        return res.status(404).json({ error: "NOT_FOUND" });
      }

      const existed = await prisma.commentReport
        .findUnique({
          where: {
            parentType_commentId_userId: {
              parentType: "agenda",
              commentId,
              userId,
            },
          } as any,
        })
        .catch(() => null);

      if (existed) {
        return res.status(409).json({ error: "ALREADY_REPORTED" });
      }

      await prisma.$transaction(async (tx) => {
        await tx.commentReport.create({
          data: {
            parentType: "agenda",
            commentId,
            userId,
            reason: reason?.slice(0, 500) ?? null,
          },
        });
        await tx.agendaComment.update({
          where: { id: commentId },
          data: { reportedCount: { increment: 1 } },
        });
      });

      return res.json({ ok: true });
    } catch (e) {
      console.error(
        "[POST /agendas/:agendaId/comments/:commentId/report] error:",
        e
      );
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default agendasRouter;
