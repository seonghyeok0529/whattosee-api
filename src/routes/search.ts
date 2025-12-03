// src/routes/search.ts
import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma.js";

export const searchRouter = Router();

type Scope = "media" | "user" | "all";

searchRouter.get("/", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  const scope = (String(req.query.scope ?? "all") as Scope);

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
     * ──────────────────────────────── */
    const clipIssuesPromise =
      scope === "user"
        ? Promise.resolve([] as any[])
        : prisma.clipIssue.findMany({
            where: {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { description: { contains: q, mode: "insensitive" } },
                { category: { contains: q, mode: "insensitive" } },
              ],
            },
            orderBy: { createdAt: "desc" },
            take: 30,
            select: {
              id: true,
              title: true,
              description: true,
              category: true,
              thumbnail: true,
              isHot: true,
              aiSummary: true,
              progressiveSummary: true,
              conservativeSummary: true,
              createdAt: true,
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
                { title: { contains: q, mode: "insensitive" } },
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
                { title: { contains: q, mode: "insensitive" } },
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

    const [issues, clipIssues, agendas, communityPostsRaw] =
      await Promise.all([
        issuesPromise,
        clipIssuesPromise,
        agendasPromise,
        communityPostsPromise,
      ]);

    // 🔹 CommunityPost → CommunityPostSummary 형태로 매핑
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
