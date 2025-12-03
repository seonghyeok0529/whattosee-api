// src/routes/search.ts
import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma.js";

export const searchRouter = Router();

type Scope = "media" | "user" | "all";

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
     *    - PUBLISHED 된 이슈만
     * ──────────────────────────────── */
    const issuesPromise =
      scope === "user"
        ? Promise.resolve([] as any[])
        : prisma.issue.findMany({
            where: {
              status: "PUBLISHED",
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
     *    - 썸네일 / 클립 개수 / uploadedAt 대응
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
              clipCount: true,   // 🔥 클립 개수
              createdAt: true,   // 🔥 uploadedAt 계산용
            },
          });

    /* ────────────────────────────────
     * 3) 유저 아젠다 검색 (Agenda)
     *    - summary 필드도 같이 내려주기
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

    const [issues, clipIssuesRaw, agendasRaw, communityPostsRaw] =
      await Promise.all([
        issuesPromise,
        clipIssuesPromise,
        agendasPromise,
        communityPostsPromise,
      ]);

    /* ────────────────────────────────
     * 뉴스 클립 이슈 매핑
     *  - NewsClipIssueCard에서 기대하는 필드 맞춰주기
     *    thumbnail / clipCount / uploadedAt / aiSummary
     * ──────────────────────────────── */
    const clipIssues = (clipIssuesRaw as any[]).map((c) => ({
      ...c,
      // description이 있을 때 aiSummary가 없으면 fallback
      aiSummary: c.aiSummary ?? c.description ?? null,
      clipCount: c.clipCount ?? 0,
      uploadedAt: c.createdAt?.toISOString?.().slice(0, 10) ?? "",
    }));

    /* ────────────────────────────────
     * 아젠다 매핑
     *  - 기존 필드는 그대로 두고 summary만 추가
     * ──────────────────────────────── */
    const agendas = (agendasRaw as any[]).map((a) => {
      const content = a.content ?? "";
      const summary =
        content.length > 120 ? `${content.slice(0, 120)}...` : content;
      return {
        ...a,
        summary,
      };
    });

    /* ────────────────────────────────
     * CommunityPost → CommunityPostSummary
     * ──────────────────────────────── */
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
