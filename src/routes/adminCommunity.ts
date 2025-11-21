// src/routes/adminCommunity.ts
import { Router, Request, Response } from "express";
import { CommunityLounge } from "@prisma/client";
import prisma from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { adminAuth } from "../middleware/adminAuth";

const router = Router();

const LOUNGE_VALUES: CommunityLounge[] = [
  "popular",
  "politics",
  "society",
  "economy",
  "international",
  "tech",
  "culture",
  "daily",
  "humor",
];

function resolveAuthor(user: any) {
    if (!user) return null;
    return {
      id: user.id,
      nickname: user.nickname ?? null,
      username: user.username ?? null,
    };
  }  

function isCommunityLounge(v: string): v is CommunityLounge {
  return LOUNGE_VALUES.includes(v as CommunityLounge);
}

/* ──────────────────────────────
 * 공통: Poll 응답 객체 만들기
 * (community.ts에서 쓰는 로직 재사용)
 * ────────────────────────────── */
function buildPollResponse(poll: any, userId?: string | null, sessionId?: string | null) {
  if (!poll) return null;

  const rawOptions = Array.isArray(poll.options) ? (poll.options as any[]) : [];
  const votes = poll.votes ?? [];
  const totalVotes = votes.length;

  const myVote =
    votes.find((v: any) => userId && v.userId === userId) ??
    votes.find((v: any) => !userId && sessionId && v.sessionId === sessionId);

  const options = rawOptions.map((opt: any) => {
    const optionId = String(opt.id ?? opt.value ?? opt.optionId);
    const label = String(opt.label ?? opt.text ?? "");
    const count = votes.filter((v: any) => v.optionId === optionId).length;
    const percentage = totalVotes ? Math.round((count / totalVotes) * 100) : 0;

    return {
      id: optionId,
      label,
      votes: count,
      percentage,
    };
  });

  return {
    question: poll.question as string,
    options,
    totalVotes,
    myChoiceId: myVote?.optionId ?? null,
    closed: !!poll.closedAt,
  };
}

/* ──────────────────────────────
 * GET /api/admin/community/posts
 * ?lounge=popular|politics...
 * ?sort=popular|latest
 * ?q=검색어
 * ?cursor=...
 * ?take=20
 * ────────────────────────────── */
router.get(
  "/community/posts",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const loungeParam = (req.query.lounge as string) || "popular";
      const sortParam = (req.query.sort as string) || "latest";
      const q = ((req.query.q as string) || "").trim();
      const cursor = (req.query.cursor as string) || null;
      const takeParam = req.query.take as string | undefined;

      const lounge: CommunityLounge = isCommunityLounge(loungeParam)
        ? (loungeParam as CommunityLounge)
        : "popular";

      const sort: "popular" | "latest" =
        sortParam === "popular" ? "popular" : "latest";

      const take = Math.min(Number(takeParam ?? 20) || 20, 100);

      const baseWhere: any =
        lounge === "popular"
          ? {} // 전체 인기
          : { lounge };

      // 관리자용 검색: 제목 / 내용 / 작성자 이름
      if (q) {
        baseWhere.OR = [
          { title: { contains: q } },
          { content: { contains: q } },
          {
            user: {
              username: { contains: q },
            },
          },
        ];
      }

      const orderBy =
        sort === "latest"
          ? [{ createdAt: "desc" as const }]
          : [
              { likesCount: "desc" as const },
              { commentCount: "desc" as const },
              { createdAt: "desc" as const },
            ];

      const posts = await prisma.communityPost.findMany({
        where: baseWhere,
        orderBy,
        take: take + 1,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        include: {
          user: true,
        },
      });

      const hasMore = posts.length > take;
      const items = hasMore ? posts.slice(0, take) : posts;
      const nextCursor = hasMore ? items[items.length - 1].id : null;

      // 관리자에서도 유저용 구조를 기본으로, + 필요하면 나중에 필드 추가
      return res.json({
        ok: true,
        items: items.map((p) => ({
          id: p.id,
          title: p.title,
          contentPreview: p.content.slice(0, 200),
          author: p.user?.username ?? "익명",
          authorCTI: p.user?.ctiType ?? null,
          likes: p.likesCount,
          comments: p.commentCount,
          views: p.viewsCount,
          createdAt: p.createdAt.toISOString(),
          lounge: p.lounge,
          isHot: p.isHot,
          thumbnail: p.thumbnail,
          // status 같은 건 나중에 post에 isDeleted 등 필드 추가하면 여기서 매핑
        })),
        nextCursor,
      });
    } catch (err) {
      console.error("GET /api/admin/community/posts error", err);
      return res
        .status(500)
        .json({ message: "관리자용 게시글 목록을 불러오지 못했습니다." });
    }
  }
);

/* ──────────────────────────────
 * GET /api/admin/community/posts/:id
 * ────────────────────────────── */
router.get(
  "/community/posts/:id",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id;

      const post = await prisma.communityPost.findUnique({
        where: { id },
        include: {
          user: true,
          comments: {
            orderBy: { createdAt: "asc" },
            include: { user: true },
          },
          links: {
            include: {
              issue: true,
              clipIssue: true,
            },
          },
          poll: {
            include: {
              votes: true,
            },
          },
        },
      });

      if (!post) {
        return res.status(404).json({ message: "게시글을 찾을 수 없습니다." });
      }

      // 조회수 증가 (운영 관점에서 굳이 안 올려도 되지만, 일단 동일하게)
      prisma.communityPost
        .update({
          where: { id },
          data: { viewsCount: { increment: 1 } },
        })
        .catch(() => {});

      const linkedIssues = post.links
        .map((link) => {
          if (link.kind === "article" && link.issue) {
            return {
              id: link.issue.id,
              title: link.issue.title,
              type: "article" as const,
              thumbnail: null as string | null,
            };
          }
          if (link.kind === "clip" && link.clipIssue) {
            return {
              id: link.clipIssue.id,
              title: link.clipIssue.title,
              type: "clip" as const,
              thumbnail: link.clipIssue.thumbnail,
            };
          }
          return null;
        })
        .filter(Boolean) as any[];

      // 관리자 뷰에서는 isDeleted인 댓글도 보고 싶을 수 있으니 그대로 노출,
      // 프론트에서 isDeleted 표시 후 숨길지 여부 선택
      const replies = post.comments.map((c) => ({
        id: c.id,
        author: c.user?.username ?? "익명",
        cti: c.user?.ctiType ?? null,
        content: c.content,
        likes: c.likes,
        createdAt: c.createdAt.toISOString(),
        isDeleted: c.isDeleted,
      }));

      const images = Array.isArray(post.images) ? (post.images as string[]) : [];

      const anyReq = req as any;
      const userId: string | undefined = anyReq.user?.id;
      const sessionId: string | undefined = anyReq.sessionId;

      const poll = buildPollResponse(post.poll, userId, sessionId);

      return res.json({
        ok: true,
        item: {
          id: post.id,
          title: post.title,
          content: post.content,
          author: post.user?.username ?? "익명",
          authorCTI: post.user?.ctiType ?? null,
          likes: post.likesCount,
          comments: post.commentCount,
          views: post.viewsCount + 1,
          createdAt: post.createdAt.toISOString(),
          lounge: post.lounge,
          thumbnail: post.thumbnail,
          images,
          linkedIssues,
          replies,
          poll,
        },
      });
    } catch (err) {
      console.error("GET /api/admin/community/posts/:id error", err);
      return res
        .status(500)
        .json({ message: "관리자용 게시글 상세를 불러오지 못했습니다." });
    }
  }
);

/* ──────────────────────────────
 * PATCH /api/admin/community/posts/:id
 * body: { title?, content?, lounge?, isHot? }
 * ────────────────────────────── */
router.patch(
  "/community/posts/:id",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const body = req.body as {
        title?: string;
        content?: string;
        lounge?: CommunityLounge;
        isHot?: boolean;
      };

      const data: any = {};
      if (typeof body.title === "string") data.title = body.title.trim();
      if (typeof body.content === "string") data.content = body.content.trim();
      if (body.lounge && isCommunityLounge(body.lounge)) {
        if (body.lounge === "popular") {
          return res
            .status(400)
            .json({ message: "popular는 직접 지정할 수 없습니다." });
        }
        data.lounge = body.lounge;
      }
      if (typeof body.isHot === "boolean") data.isHot = body.isHot;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ message: "수정할 필드가 없습니다." });
      }

      const updated = await prisma.communityPost.update({
        where: { id },
        data,
      });

      return res.json({ ok: true, item: updated });
    } catch (err) {
      console.error("PATCH /api/admin/community/posts/:id error", err);
      return res
        .status(500)
        .json({ message: "게시글 수정에 실패했습니다." });
    }
  }
);

/* ──────────────────────────────
 * DELETE /api/admin/community/posts/:id
 * (현재는 하드 삭제, 필요하면 나중에 isDeleted 필드 추가해서 soft-delete로 변경)
 * ────────────────────────────── */
router.delete(
  "/community/posts/:id",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id;

      await prisma.communityPost.delete({
        where: { id },
      });

      return res.json({ ok: true });
    } catch (err: any) {
      console.error("DELETE /api/admin/community/posts/:id error", err);
      if (err.code === "P2025") {
        return res.status(404).json({ message: "게시글을 찾을 수 없습니다." });
      }
      return res
        .status(500)
        .json({ message: "게시글 삭제에 실패했습니다." });
    }
  }
);

/* ──────────────────────────────
 * GET /api/admin/community/posts/:id/comments
 * ────────────────────────────── */
router.get(
  "/community/posts/:id/comments",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const postId = req.params.id;
      const take = Math.min(
        Number((req.query.take as string) ?? 50) || 50,
        200
      );
      const cursor = (req.query.cursor as string) || null;

      const comments = await prisma.communityPostComment.findMany({
        where: { postId },
        orderBy: { createdAt: "asc" },
        take: take + 1,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        include: {
          user: true,
        },
      });

      const hasMore = comments.length > take;
      const items = hasMore ? comments.slice(0, take) : comments;
      const nextCursor = hasMore ? items[items.length - 1].id : null;

      return res.json({
        ok: true,
        items: items.map((c) => ({
          id: c.id,
          author: c.user?.username ?? "익명",
          cti: c.user?.ctiType ?? null,
          content: c.content,
          likes: c.likes,
          createdAt: c.createdAt.toISOString(),
          isDeleted: c.isDeleted,
        })),
        nextCursor,
      });
    } catch (err) {
      console.error(
        "GET /api/admin/community/posts/:id/comments error",
        err
      );
      return res
        .status(500)
        .json({ message: "댓글 목록을 불러오지 못했습니다." });
    }
  }
);

/* ──────────────────────────────
 * POST /api/admin/community/comments/:id/hide
 * body: { reason? }
 * → isDeleted = true
 * ────────────────────────────── */
router.post(
  "/community/comments/:id/hide",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      // const { reason } = (req.body ?? {}) as { reason?: string }; // 나중에 로그에 쓰고 싶으면 사용

      const updated = await prisma.communityPostComment.update({
        where: { id },
        data: {
          isDeleted: true,
        },
      });

      return res.json({ ok: true, item: updated });
    } catch (err: any) {
      console.error("POST /api/admin/community/comments/:id/hide error", err);
      if (err.code === "P2025") {
        return res.status(404).json({ message: "댓글을 찾을 수 없습니다." });
      }
      return res
        .status(500)
        .json({ message: "댓글 숨김 처리에 실패했습니다." });
    }
  }
);

/* ──────────────────────────────
 * POST /api/admin/community/comments/:id/restore
 * → isDeleted = false
 * ────────────────────────────── */
router.post(
  "/community/comments/:id/restore",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id;

      const updated = await prisma.communityPostComment.update({
        where: { id },
        data: {
          isDeleted: false,
        },
      });

      return res.json({ ok: true, item: updated });
    } catch (err: any) {
      console.error(
        "POST /api/admin/community/comments/:id/restore error",
        err
      );
      if (err.code === "P2025") {
        return res.status(404).json({ message: "댓글을 찾을 수 없습니다." });
      }
      return res
        .status(500)
        .json({ message: "댓글 복원에 실패했습니다." });
    }
  }
);

/* ──────────────────────────────
 * DELETE /api/admin/community/comments/:id
 * (하드 삭제)
 * ────────────────────────────── */
router.delete(
  "/community/comments/:id",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id;

      await prisma.communityPostComment.delete({
        where: { id },
      });

      return res.json({ ok: true });
    } catch (err: any) {
      console.error(
        "DELETE /api/admin/community/comments/:id error",
        err
      );
      if (err.code === "P2025") {
        return res.status(404).json({ message: "댓글을 찾을 수 없습니다." });
      }
      return res
        .status(500)
        .json({ message: "댓글 삭제에 실패했습니다." });
    }
  }
);

export default router;
