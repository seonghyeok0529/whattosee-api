// src/routes/search.ts
import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma.js";
import he from "he";

export const searchRouter = Router();

type Scope = "media" | "user" | "all";

const decode = (s?: string | null) => (s ? he.decode(s) : "");

searchRouter.get("/", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  const scope = String(req.query.scope ?? "all") as Scope;

  if (!q) {
    return res.json({
      issues: [] as any[],
      clipIssues: [] as any[],
      agendas: [] as any[],
      communityPosts: [] as any[],
    });
  }

  try {
    /* ────────────────────────────────
     * 1) 인터넷 기사 이슈 검색 (Issue)
     * ──────────────────────────────── */
    const issuesPromise =
      scope === "user"
        ? Promise.resolve([] as any[])
        : prisma.issue.findMany({
            where: {
              status: "PUBLISHED", // 🔥 등록(공개)된 이슈만
              OR: [
                { title:   { contains: q, mode: "insensitive" } },
                { summary: { contains: q, mode: "insensitive" } },
                { body:    { contains: q, mode: "insensitive" } },
                {
                  sources: {
                    some: {
                      OR: [
                        { outlet: { contains: q, mode: "insensitive" } },
                        { title:  { contains: q, mode: "insensitive" } },
                      ],
                    },
                  },
                },
              ],
            },
            orderBy: { createdAt: "desc" },
            take: 30,
            select: {
              id: true,
              title: true,
              summary: true,
              tags: true,
              createdAt: true,
              updatedAt: true,
              thumbnailUrl: true,
              leftSummary: true,
              rightSummary: true,
              sources: {
                take: 4,
                orderBy: { createdAt: "asc" },
                select: {
                  outlet: true,
                  side: true,
                  createdAt: true,
                },
              },
            },
          });

    /* ────────────────────────────────
     * 2) 뉴스 클립 이슈 검색 (ClipIssue)
     *    → /api/news-clips 와 동일한 로직으로 썸네일 구성
     * ──────────────────────────────── */
    const clipIssuesPromise =
      scope === "user"
        ? Promise.resolve([] as any[])
        : prisma.clipIssue.findMany({
            where: {
              OR: [
                { title:       { contains: q, mode: "insensitive" } },
                { description: { contains: q, mode: "insensitive" } },
                { category:    { contains: q, mode: "insensitive" } },
              ],
            },
            orderBy: { createdAt: "desc" },
            take: 30,
            include: {
              _count: { select: { comments: true } },
              clips: {
                include: { rawClip: true },
                orderBy: { rawClip: { publishedAt: "asc" } },
                take: 1,
              },
            },
          });

    /* ────────────────────────────────
     * 3) 유저 아젠다 검색 (Agenda)
     * ──────────────────────────────── */
    const agendasPromise =
      scope === "media"
        ? Promise.resolve([] as any[])
        : prisma.agenda.findMany({
            where: {
              OR: [
                { title:   { contains: q, mode: "insensitive" } },
                { content: { contains: q, mode: "insensitive" } },
              ],
            },
            orderBy: { createdAt: "desc" },
            take: 30,
            select: {
              id: true,
              title: true,
              content: true,
              tags: true,
              createdAt: true,
              likesCount: true,
              commentCount: true,
            },
          });

    /* ────────────────────────────────
     * 4) 커뮤니티 글 검색 (CommunityPost)
     *    → 프론트의 CommunityPostSummary 타입에 맞게 변환
     * ──────────────────────────────── */
    const communityPostsPromise =
      scope === "media"
        ? Promise.resolve([] as any[])
        : prisma.communityPost.findMany({
            where: {
              OR: [
                { title:   { contains: q, mode: "insensitive" } },
                { content: { contains: q, mode: "insensitive" } },
              ],
            },
            orderBy: { createdAt: "desc" },
            take: 30,
            select: {
              id: true,
              title: true,
              content: true,
              createdAt: true,
              lounge: true,
              isHot: true,
              thumbnail: true,
              likesCount: true,
              commentCount: true,
              viewsCount: true,
              user: {
                select: {
                  username: true,
                  nickname: true,
                  ctiType: true,
                },
              },
            },
          });

    const [issues, clipIssuesRaw, agendas, communityPostsRaw] =
      await Promise.all([
        issuesPromise,
        clipIssuesPromise,
        agendasPromise,
        communityPostsPromise,
      ]);

    /* ───────── ClipIssue → NewsClipIssue 형태로 변환 ───────── */
    const clipIssues = (clipIssuesRaw as any[]).map((it) => {
      const firstClipThumb = it.clips?.[0]?.rawClip?.thumbnail ?? "";
      const thumb = it.thumbnail ?? firstClipThumb;

      const created =
        it.createdAt instanceof Date
          ? it.createdAt
          : new Date(it.createdAt);

      return {
        id: it.id,
        title: decode(it.title),
        description: decode(it.description),
        thumbnail: thumb,
        clipCount: it.clipCount,          // schema에 있는 필드
        totalViews: it.totalViews,        // 있으면 같이 내려줌
        category: it.category ?? "뉴스",
        isHot: it.isHot,
        uploadedAt: created.toISOString().slice(0, 10),
        commentCount: it._count?.comments ?? 0,
        aiSummary: decode(it.aiSummary),
        progressiveSummary: decode(it.progressiveSummary),
        conservativeSummary: decode(it.conservativeSummary),
      };
    });

    /* ───────── CommunityPost → CommunityPostSummary ───────── */
    const communityPosts = (communityPostsRaw as any[]).map((p) => ({
      id: p.id,
      title: p.title,
      contentPreview:
        (p.content ?? "").length > 120
          ? `${p.content.slice(0, 120)}...`
          : p.content ?? "",
      author: p.user?.nickname ?? p.user?.username ?? "익명",
      authorCTI: p.user?.ctiType ?? null,
      likes: p.likesCount,
      comments: p.commentCount,
      views: p.viewsCount,
      createdAt: p.createdAt,
      lounge: p.lounge,
      isHot: p.isHot,
      thumbnail: p.thumbnail,
    }));

    return res.json({
      issues,
      clipIssues,
      agendas,
      communityPosts,
    });
  } catch (e) {
    console.error("[GET /api/search] error:", e);
    return res.json({
      issues: [] as any[],
      clipIssues: [] as any[],
      agendas: [] as any[],
      communityPosts: [] as any[],
    });
  }
});

export default searchRouter;
