// src/routes/adminAgenda.ts
import { Router, Request, Response, NextFunction } from "express";
import prisma from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

const adminAgendaRouter = Router();

// 공통 매핑 함수: DB Agenda -> AdminAgenda DTO
function mapAgenda(a: any) {
  return {
    id: a.id,
    title: a.title,
    content: a.content,
    tags: (a.tags as string[]) ?? [],
    category: ((a.tags as string[])?.[0] as string) ?? "기타",
    author: a.user?.username ?? "익명",
    authorCTI: a.user?.ctiType ?? null,
    views: 0, // TODO: PageView 연동 시 교체
    likes: a.likesCount ?? 0,
    comments: a.commentCount ?? 0,
    date: a.createdAt.toISOString().slice(0, 10),
    status: a.deletedAt ? "deleted" : "active",
  };
}

/**
 * GET /api/admin/agendas
 * 쿼리: q, status=active|deleted, category
 */
adminAgendaRouter.get(
  "/agendas",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q, status, category } = req.query as {
        q?: string;
        status?: string;
        category?: string;
      };

      const where: any = {};

      // soft delete
      if (status === "deleted") {
        where.deletedAt = { not: null };
      } else if (status === "active") {
        where.deletedAt = null;
      } else {
        // status 파라미터 없으면 기본: 삭제 안 된 것만
        where.deletedAt = null;
      }

      if (q && q.trim().length > 0) {
        where.OR = [
          { title: { contains: q, mode: "insensitive" } },
          { content: { contains: q, mode: "insensitive" } },
          {
            user: {
              OR: [
                { username: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
              ],
            },
          },
        ];
      }

      if (category && category !== "전체") {
        // tags: String[] 인 경우
        where.tags = { has: category };
      }

      const agendas = await prisma.agenda.findMany({
        where,
        include: { user: true },
        orderBy: { createdAt: "desc" },
      });

      const items = agendas.map(mapAgenda);

      return res.json({ ok: true, items });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/admin/agendas/:id
 * body: { title?, content?, category?, tags? }
 */
adminAgendaRouter.patch(
  "/agendas/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { title, content, category, tags } = req.body as {
        title?: string;
        content?: string;
        category?: string;
        tags?: string[];
      };

      const data: any = {};

      if (typeof title === "string") data.title = title;
      if (typeof content === "string") data.content = content;

      // tags / category 동기화
      let nextTags: string[] | undefined;

      if (Array.isArray(tags)) {
        nextTags = [...tags];
      }

      if (typeof category === "string" && category.trim().length > 0) {
        if (!nextTags || nextTags.length === 0) {
          nextTags = [category];
        } else {
          // 첫 번째 태그를 카테고리로 사용
          nextTags[0] = category;
        }
      }

      if (nextTags) {
        data.tags = nextTags;
      }

      const updated = await prisma.agenda.update({
        where: { id },
        data,
        include: { user: true },
      });

      return res.json({ ok: true, item: mapAgenda(updated) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/admin/agendas/:id/delete
 * soft delete: deletedAt 설정
 */
adminAgendaRouter.post(
  "/agendas/:id/delete",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      await prisma.agenda.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/admin/agendas/:id/restore
 * soft delete 해제: deletedAt null
 */
adminAgendaRouter.post(
  "/agendas/:id/restore",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      await prisma.agenda.update({
        where: { id },
        data: { deletedAt: null },
      });

      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

export default adminAgendaRouter;
