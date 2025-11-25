// src/routes/adminIssue.ts
import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { IssueStatus, Prisma, ClusterSuggestionStatus, UserStatus } from "@prisma/client";
import { IssueStatus as PrismaIssueStatus } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { adminAuth } from "../middleware/adminAuth"; 
import { generateIssueSummary } from "../services/generateIssueSummary";
import { generateIssueTitle } from "../services/generateIssueTitle";
import { OpenAI } from "openai";
import { generateSideSummary } from "../services/generateSideSummary";
import { refreshIssueGlossary } from "../services/issueGlossary";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export const adminIssueRoutes = Router();



// 🔧 articleIds = URL 배열을 기준으로 Issue.sources 동기화
async function syncIssueSourcesByUrls(issueId: string, articleIds?: string[]) {
    if (!Array.isArray(articleIds)) return;
  
    const urls = Array.from(
      new Set(
        articleIds
          .map((u) => (u ?? "").trim())
          .filter((u) => u.length > 0)
      )
    );
    if (urls.length === 0) {
      // 선택 기사 없으면 이 이슈의 sources 비우기 (정책 맞게)
      await prisma.source.deleteMany({ where: { issueId } });
      return;
    }
  
    // url 기준 RawArticle 메타 조회
    const raws = await prisma.rawArticle.findMany({
      where: { url: { in: urls } },
      select: {
        url: true,
        outlet: true,
        title: true,
        side: true,
      },
    });
    const rawByUrl = new Map(raws.map((r) => [r.url, r]));
  
    // 기존에 이 이슈에 연결돼 있지만, 더 이상 선택되지 않은 기사 삭제
    await prisma.source.deleteMany({
      where: {
        issueId,
        url: { notIn: urls },
      },
    });
  
    // 선택된 URL에 맞춰 upsert
    for (const url of urls) {
      const raw = rawByUrl.get(url);
  
      await prisma.source.upsert({
        where: { url }, // 🔐 Source.url 이 unique 라는 가정 (이미 approve 로직도 이렇게 사용 중)
        update: {
          issueId,
          outlet: raw?.outlet ?? "언론",
          title: raw?.title ?? "(제목 없음)",
          side: (raw?.side as any) ?? "center",
        },
        create: {
          issueId,
          url,
          outlet: raw?.outlet ?? "언론",
          title: raw?.title ?? "(제목 없음)",
          side: (raw?.side as any) ?? "center",
        },
      });
    }
  }

/* ─────────────────────────────────────────────
   Helper: status 매핑 (소문자/대문자 둘 다 허용)
───────────────────────────────────────────── */
function toIssueStatus(input?: string | null): IssueStatus {
  const v = (input ?? "").toUpperCase();
  switch (v) {
    case "PUBLISHED":
    case "PUBLISH":
      return IssueStatus.PUBLISHED;
    case "ARCHIVED":
    case "ARCHIVE":
      return IssueStatus.ARCHIVED;
    case "SUGGESTED":
      return IssueStatus.SUGGESTED;
    case "DRAFT":
    default:
      return IssueStatus.DRAFT;
  }
}

/* ─────────────────────────────────────────────
   1. 이슈 리스트 (관리자)
   GET /api/admin/issues
───────────────────────────────────────────── */
adminIssueRoutes.get(
  "/issues",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    // 🔹 statusRaw 로 받아서 toIssueStatus 로 매핑
    const statusRaw = (req.query.status as string | undefined)?.trim();
    const q = (req.query.q as string | undefined)?.trim() ?? "";
    const sort = (req.query.sort as string | undefined) || "latest";
    const takeRaw = parseInt((req.query.take as string) ?? "20", 10);
    const take = Math.min(isNaN(takeRaw) ? 20 : takeRaw, 100);
    const cursor = (req.query.cursor as string | undefined) ?? undefined;

    const where: Prisma.IssueWhereInput = {};

    if (statusRaw && statusRaw.toUpperCase() !== "ALL") {
      // "draft" / "published" / "PUBLISH" / "ARCHIVE" 전부 허용
      where.status = toIssueStatus(statusRaw);
    }

    if (q) {
      where.OR = [
        { title: { contains: q } },
        { summary: { contains: q } },
      ];
    }

    const query: Prisma.IssueFindManyArgs = {
      where,
      take: take + 1,
      orderBy: {
        createdAt: sort === "oldest" ? "asc" : "desc",
      },
      select: {
        id: true,
        title: true,
        summary: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            sources: true,
            comments: true,
          },
        },
      },
    };

    if (cursor) {
      query.cursor = { id: cursor };
      (query as any).skip = 1;
    }

    const items = (await prisma.issue.findMany(query as any)) as any[];

    let nextCursor: string | null = null;
    if (items.length > take) {
      const last = items.pop()!;
      nextCursor = last.id;
    }

    return res.json({
      items: items.map((i) => ({
        id: i.id,
        title: i.title,
        summary: i.summary,
        status: i.status,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        sourcesCount: i._count?.sources ?? 0,
        commentsCount: i._count?.comments ?? 0,
      })),
      nextCursor,
    });
  }
);




/* ─────────────────────────────────────────────
   2. 이슈 간단 검색
   GET /api/admin/issues/search
───────────────────────────────────────────── */
adminIssueRoutes.get("/issues/search", async (req, res) => {
    try {
      const q = (req.query.q as string | undefined)?.trim();
      const status = (req.query.status as string | undefined)?.trim();
      const take = Math.min(Number(req.query.take) || 1000, 1000);
  
      const where: any = {};
  
      // 🔍 검색어: SQLite에서는 mode: "insensitive" 지원 안 하므로 제거
      if (q) {
        where.OR = [
          { title: { contains: q } },
          { summary: { contains: q } },
        ];
      }
  
      // 🔹 상태 필터
      if (status && status !== "all") {
        // 프론트는 "draft/published/archived/suggested" 소문자 문자열을 보냄
        const map: Record<string, IssueStatus> = {
          draft: IssueStatus.DRAFT,
          published: IssueStatus.PUBLISHED,
          archived: IssueStatus.ARCHIVED,
          suggested: IssueStatus.SUGGESTED,
        };
        if (map[status]) {
          where.status = map[status];
        }
      }
  
      const issues = await prisma.issue.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        include: {
          _count: {
            select: {
              sources: true,
              comments: true,
              relatedFrom: true,
              relatedTo: true,
            },
          },
        },
      });
  
      const items = issues.map((i) => {
        const sourcesCount = i._count?.sources ?? 0;
        const commentsCount = i._count?.comments ?? 0;
        const relatedFromCount = i._count?.relatedFrom ?? 0;
        const relatedToCount = i._count?.relatedTo ?? 0;
  
        return {
          id: i.id,
          title: i.title,
          summary: i.summary,
          status: i.status, // 필요하면 String(i.status).toLowerCase() 로 바꿔도 됨
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
          articlesCount: sourcesCount,
          commentsCount,
          relatedIssuesCount: relatedFromCount + relatedToCount,
        };
      });
  
      res.json({
        ok: true,
        items,
        nextCursor: null,
      });
    } catch (e: any) {
      console.error("GET /api/admin/issues/search error", e);
      res.status(500).json({
        ok: false,
        error: "INTERNAL_ERROR",
        detail: String(e?.message ?? e),
      });
    }
  });

/* ─────────────────────────────────────────────
   X. 추천 이슈 기반 자동 이슈 생성
   POST /api/admin/issues/auto-generate
───────────────────────────────────────────── */
adminIssueRoutes.post(
  "/issues/auto-generate",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const { take, minArticles, days } = req.body as {
        take?: number;
        minArticles?: number;
        days?: number;
      };

      const now = new Date();
      const daysWindow = typeof days === "number" && days > 0 ? days : 2;
      const fromDate = new Date(
        now.getTime() - daysWindow * 24 * 60 * 60 * 1000
      );

      const takeLimit = Math.min(typeof take === "number" ? take : 20, 100);

      const suggestions = await prisma.clusterSuggestion.findMany({
        where: {
          status: ClusterSuggestionStatus.PENDING,
          issueId: null,
          createdAt: {
            gte: fromDate,
          },
        },
        orderBy: { createdAt: "desc" },
        take: takeLimit,
        include: {
          articles: true,
        },
      });

      const minCount = typeof minArticles === "number" && minArticles > 0 ? minArticles : 2;

      const filtered = suggestions.filter(
        (s) => (s.articles?.length ?? 0) >= minCount
      );

      const createdIssueIds: string[] = [];

      for (const sug of filtered) {
        // 1) 이슈 생성 (일단 status는 DRAFT)
        const issue = await prisma.issue.create({
          data: {
            title: sug.title ?? "(제목 없음)",
            summary: sug.summary ?? null,
            tags: [], // 필요하면 키워드 매핑
            status: IssueStatus.DRAFT,
          },
        });

        createdIssueIds.push(issue.id);

        // 2) 기사 URL 리스트 추출
        const articleUrls = (sug.articles ?? [])
          .map((a) => (a.url ?? "").trim())
          .filter((u) => u.length > 0);

        // 3) Source 동기화
        await syncIssueSourcesByUrls(issue.id, articleUrls);

        // 4) clusterSuggestion 상태 업데이트 (APPROVED + issueId 연결)
        await prisma.clusterSuggestion.update({
          where: { id: sug.id },
          data: {
            status: ClusterSuggestionStatus.APPROVED,
            issueId: issue.id,
          },
        });

        // 5) 제목/요약 AI로 한 번 더 다듬기 (실패해도 전체 플로우는 계속)
        try {
          const fullIssue = await prisma.issue.findUnique({
            where: { id: issue.id },
            include: { sources: true },
          });

          if (fullIssue) {
            const aiTitle = await generateIssueTitle(fullIssue as any);
            const aiSummary = await generateIssueSummary(fullIssue as any);

            await prisma.issue.update({
              where: { id: issue.id },
              data: {
                ...(aiTitle?.trim()?.length
                  ? { title: aiTitle.trim() }
                  : {}),
                ...(aiSummary?.trim()?.length
                  ? { summary: aiSummary.trim() }
                  : {}),
              },
            });
          }
        } catch (e) {
          console.error(
            "[/api/admin/issues/auto-generate] AI 생성 실패:",
            e
          );
        }
      }

      return res.json({
        ok: true,
        createdIssueCount: createdIssueIds.length,
        issueIds: createdIssueIds,
      });
    } catch (e: any) {
      console.error(
        "[POST /api/admin/issues/auto-generate] error:",
        e
      );
      return res.status(500).json({
        ok: false,
        error: "INTERNAL_ERROR",
        detail: String(e?.message ?? e),
      });
    }
  }
);


/* ─────────────────────────────────────────────
   10. 추천 이슈 목록 (IssuesTab "추천 이슈" 탭용)
   GET /api/admin/issues/recommended
───────────────────────────────────────────── */
adminIssueRoutes.get(
    "/issues/recommended",
    requireAuth,
    adminAuth,
    async (req: Request, res: Response) => {
      // 🔹 클라이언트에서 ?take= 를 넘기면 사용하고, 없으면 100
      //    최대 10,000까지 허용
      const takeRaw = parseInt((req.query.take as string) ?? "100", 10);
      const take = Math.min(isNaN(takeRaw) ? 100 : takeRaw, 10000);
  
      try {
        const suggestions = await prisma.clusterSuggestion.findMany({
            where: { status: ClusterSuggestionStatus.PENDING, issueId: null },
            take,
            orderBy: { createdAt: "desc" },
            include: {
              articles: {
                include: {
                  raw: true, // 🔵 rawArticle 같이 로드
                },
              },
            },
          });
  
        // 🔹 기사 2개 이상인 추천 이슈만 필터링
        const filtered = suggestions.filter(
          (sug) => (sug.articles?.length ?? 0) >= 2
        );
  
        const items = filtered.map((sug) => {
          const articles = sug.articles ?? [];
  
          // 날짜 범위 계산
          let minDate: Date | null = null;
          let maxDate: Date | null = null;
          for (const a of articles) {
            if (!a.publishedAt) continue;
            const d = a.publishedAt;
            if (!minDate || d < minDate) minDate = d;
            if (!maxDate || d > maxDate) maxDate = d;
          }
  
          const dateRange =
            minDate && maxDate
              ? `${minDate.toISOString().slice(0, 10)} ~ ${maxDate
                  .toISOString()
                  .slice(0, 10)}`
              : "";
  
          // 키워드: summary를 공백/쉼표 기준으로 잘라 상위 8개
          const keywords =
            (sug.summary ?? "")
              .split(/[,\s]+/)
              .map((k) => k.trim())
              .filter(Boolean)
              .slice(0, 8) || [];
  
          return {
            id: sug.id,
            title: sug.title,
            confidence: sug.confidence ?? 0,
            articleCount: articles.length,
            dateRange,
            keywords,
            articles: articles.map((a) => {
                const raw = a.raw;
                const url = a.url ?? raw?.url ?? "";
                const rawDate = a.publishedAt ?? raw?.publishedAt ?? null;
              
                return {
                  id: url || String(raw?.id ?? a.id),   // ✅ ID = URL
                  title: a.title ?? raw?.title ?? "(제목 없음)",
                  source: a.outlet ?? raw?.outlet ?? "언론",
                  date: rawDate ? rawDate.toISOString().slice(0, 10) : "",
                  url,
                  summary: a.summary ?? "",
                  side: a.side ?? raw?.side ?? "center",
                };
              }),
          };
        });
  
        // 🔹 페이지네이션 안 쓰니까 nextCursor는 항상 null
        res.json({ ok: true, items, nextCursor: null });
      } catch (e) {
        console.error("[admin/issues/recommended] error:", e);
        res.status(500).json({ error: "RECOMMENDED_ERROR" });
      }
    }
  );

/* ─────────────────────────────────────────────
   3. 이슈 상세 (관리자용)
   GET /api/admin/issues/:id
   - 연관 이슈 + 포함 기사(AdminArticle 형태) 반환
───────────────────────────────────────────── */
adminIssueRoutes.get("/issues/:id", async (req, res) => {
    try {
      const id = req.params.id;
  
      const issue = await prisma.issue.findUnique({
        where: { id },
        include: {
          sources: {
            select: {
              id: true,
              url: true,
              outlet: true,
              title: true,
              side: true,
              createdAt: true,
            },
          },
          relatedFrom: {
            include: { to: true },
          },
          relatedTo: {
            include: { from: true },
          },
        },
      });
  
      if (!issue) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }
  
      // 1) Source.url 목록 추출
      const urls = issue.sources
        .map((s) => s.url)
        .filter((u): u is string => !!u && u.trim().length > 0);
  
      // 2) URL 기준으로 rawArticle 조회
      let rawByUrl = new Map<string, any>();
      if (urls.length > 0) {
        const raws = await prisma.rawArticle.findMany({
          where: { url: { in: urls } },
          select: {
            id: true,
            url: true,
            publishedAt: true,
            text: true,
            outlet: true,
            title: true,
            side: true,
          },
        });
  
        rawByUrl = new Map(
          raws.map((r) => [
            r.url,
            {
              id: String(r.id),
              publishedAt: r.publishedAt,
              text: r.text,
              outlet: r.outlet,
              title: r.title,
              side: r.side,
            },
          ])
        );
      }
  
      // 3) 최종 AdminArticle로 매핑
      const articles = issue.sources.map((s) => {
        const raw = s.url ? rawByUrl.get(s.url) : undefined;
      
        const url = s.url ?? raw?.url ?? "";
        const publishedAt = raw?.publishedAt ?? s.createdAt;
        const summary = raw?.text ? raw.text.slice(0, 300) : "";
        const outlet = raw?.outlet ?? s.outlet ?? "언론";
        const title = raw?.title ?? s.title ?? "(제목 없음)";
        const side = raw?.side ?? s.side ?? "center";
      
        return {
          id: url || String(raw?.id ?? s.id), // ✅ ID = URL
          title,
          source: outlet,
          date: publishedAt ? publishedAt.toISOString().slice(0, 10) : "",
          url,
          summary,
          side,
          keywords: [] as string[],
        };
      });
      
      const articleIds = articles.map((a) => a.id); // ✅ 이제 전부 URL 배열
  
      // 4) 연관 이슈 그대로
      const relationsFrom = issue.relatedFrom.map((r) => ({
        id: r.to.id,
        title: r.to.title,
        status: r.to.status,
        relationId: r.id,
        relationType: r.relationType,
        direction: "FROM" as const,
        confidence: r.confidence,
        createdAt: r.createdAt,
      }));
  
      const relationsTo = issue.relatedTo.map((r) => ({
        id: r.from.id,
        title: r.from.title,
        status: r.from.status,
        relationId: r.id,
        relationType: r.relationType,
        direction: "TO" as const,
        confidence: r.confidence,
        createdAt: r.createdAt,
      }));
  
      return res.json({
        ok: true,
        item: {
          id: issue.id,
          title: issue.title,
          summary: issue.summary,
          status: issue.status,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          keywords: issue.tags ?? [],
          articles,
          articleIds,
          relatedIssues: [...relationsFrom, ...relationsTo],
          leftSummary: issue.leftSummary,
          rightSummary: issue.rightSummary,
        },
      });
    } catch (e) {
      console.error("GET /api/admin/issues/:id error", e);
      return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
    }
  });

/* ─────────────────────────────────────────────
   4. 이슈 생성 + AI 자동 요약/제목 생성
   POST /api/admin/issues
───────────────────────────────────────────── */
adminIssueRoutes.post(
    "/issues",
    requireAuth,
    adminAuth,
    async (req: Request, res: Response) => {
      try {
        const {
          title,
          summary,
          status,
          articleIds,
          keywords,
          fromSuggestionId,
          leftSummary,
          rightSummary,
        } = req.body as {
          title?: string;
          summary?: string;
          status?: string;
          articleIds?: string[];
          keywords?: string[];
          fromSuggestionId?: string | null;
          leftSummary?: string;
          rightSummary?: string;
        };
  
        // 1) 일단 빈 값이라도 생성
        const issue = await prisma.issue.create({
          data: {
            title: title?.trim() || "(제목 없음)",
            summary: summary?.trim() ?? null,
            tags: Array.isArray(keywords) ? keywords : [],
            status: toIssueStatus(status),
            leftSummary: leftSummary?.trim() ?? null,
            rightSummary: rightSummary?.trim() ?? null,
          },
        });
  
        // 2) Source 연결
        await syncIssueSourcesByUrls(issue.id, articleIds);
  
        // 3) 추천 이슈 승인 처리
        if (fromSuggestionId) {
          try {
            await prisma.clusterSuggestion.update({
              where: { id: fromSuggestionId },
              data: {
                status: ClusterSuggestionStatus.APPROVED,
                issueId: issue.id,
              },
            });
          } catch (e) {
            console.error("[POST /issues] suggestion linking failed:", e);
          }
        }
  
        // 4) AI 자동 생성 (제목, 요약)
        let finalIssue = issue;
  
        try {
          const fullIssue = await prisma.issue.findUnique({
            where: { id: issue.id },
            include: { sources: true },
          });
  
          if (fullIssue) {
            const aiTitle = await generateIssueTitle(fullIssue as any);
            const aiSummary = await generateIssueSummary(fullIssue as any);
  
            const updated = await prisma.issue.update({
              where: { id: issue.id },
              data: {
                title:
                  title?.trim()?.length
                    ? title.trim() // 사람이 입력한 제목이 있으면 유지
                    : aiTitle?.trim()?.length
                        ? aiTitle.trim()
                        : fullIssue.title,
  
                summary:
                  summary?.trim()?.length
                    ? summary.trim()
                    : aiSummary?.trim()?.length
                        ? aiSummary.trim()
                        : fullIssue.summary,
              },
            });
  
            finalIssue = updated;
          }
        } catch (e) {
          console.error("[POST /api/admin/issues] AI 생성 실패:", e);
        }
  
        return res.json({ ok: true, item: finalIssue });
      } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, message: "INTERNAL_ERROR" });
      }
    }
  );

/* ─────────────────────────────────────────────
   5. 이슈 수정
   PATCH /api/admin/issues/:id
   body: { title?, summary?, status?, articleIds?, keywords? }
   - articleIds 전달되면 Source 집합 재구성
───────────────────────────────────────────── */
adminIssueRoutes.patch(
  "/issues/:id",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { title, summary, status, articleIds, keywords, leftSummary, rightSummary } = req.body as {
      title?: string;
      summary?: string;
      status?: string;
      articleIds?: string[];
      keywords?: string[];
      leftSummary?: string;
      rightSummary?: string;
    };

    try {
      const issue = await prisma.issue.update({
        where: { id },
        data: {
            ...(title !== undefined ? { title: title.trim() } : {}),
            ...(summary !== undefined
              ? { summary: summary?.trim() ?? null }
              : {}),
            ...(status !== undefined ? { status: toIssueStatus(status) } : {}),
            ...(keywords !== undefined
              ? { tags: Array.isArray(keywords) ? keywords : [] }
              : {}),
            ...(leftSummary !== undefined
              ? { leftSummary: leftSummary.trim() }
              : {}),
            ...(rightSummary !== undefined
              ? { rightSummary: rightSummary.trim() }
              : {}),
          },
      });

      if (Array.isArray(articleIds)) {
        await syncIssueSourcesByUrls(id, articleIds);
      }

      return res.json({ ok: true, item: issue });
    } catch (err) {
      console.error(err);
      return res
        .status(500)
        .json({ ok: false, message: "INTERNAL_ERROR" });
    }
  }
);

/* ─────────────────────────────────────────────
   6. 이슈 등록 해제 (ARCHIVED)
   POST /api/admin/issues/:id/unregister
───────────────────────────────────────────── */
adminIssueRoutes.post(
  "/issues/:id/unregister",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
      const updated = await prisma.issue.update({
        where: { id },
        data: { status: IssueStatus.ARCHIVED },
      });

      return res.json({ ok: true, item: updated });
    } catch (err) {
      console.error(err);
      return res
        .status(500)
        .json({ ok: false, message: "INTERNAL_ERROR" });
    }
  }
);

/* ─────────────────────────────────────────────
   7. 이슈 간 연관 관계 추가/삭제 (기존 코드 유지)
───────────────────────────────────────────── */
adminIssueRoutes.post(
  "/issues/:id/relations",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { targetId } = req.body as { targetId?: string };

    if (!targetId || targetId === id) {
      return res.status(400).json({ ok: false, message: "invalid targetId" });
    }

    await prisma.issueRelation.upsert({
      where: {
        fromIssueId_toIssueId: {
          fromIssueId: id,
          toIssueId: targetId,
        },
      },
      create: {
        fromIssueId: id,
        toIssueId: targetId,
        relationType: "RELATED",
      },
      update: {},
    });

    res.json({ ok: true });
  }
);

adminIssueRoutes.delete(
  "/issues/:id/relations/:targetId",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    const { id, targetId } = req.params;

    await prisma.issueRelation
      .delete({
        where: {
          fromIssueId_toIssueId: {
            fromIssueId: id,
            toIssueId: targetId,
          },
        },
      })
      .catch(() => null);

    res.json({ ok: true });
  }
);

/* ─────────────────────────────────────────────
   8. 유저 / 인물 / 리포트 / 기사 검색 (기존 로직 유지)
───────────────────────────────────────────── */

adminIssueRoutes.get(
    "/users",
    requireAuth,
    adminAuth,
    async (req: Request, res: Response) => {
      try {
        const q = (req.query.q as string | undefined)?.trim() ?? "";
        const takeRaw = parseInt((req.query.take as string) ?? "50", 10);
        const take = Math.min(isNaN(takeRaw) ? 50 : takeRaw, 100);
        const cursor = (req.query.cursor as string | undefined) ?? undefined;
  
        const where: Prisma.UserWhereInput = q
          ? {
              OR: [
                { email: { contains: q } },
                { username: { contains: q } },
              ],
            }
          : {};
  
        const query: Prisma.UserFindManyArgs = {
          where,
          take: take + 1,
          orderBy: { createdAt: "desc" },
          // 🔹 _count 포함해서 댓글/좋아요/투표 수 집계
          include: {
            _count: {
              select: {
                comments: true,          // AgendaComment[]
                likes: true,             // AgendaLike[]
                issueComments: true,     // IssueComment[]
                issueCommentLikes: true, // IssueCommentLike[]
                votes: true,             // Vote[]
              },
            },
          },
        };
  
        if (cursor) {
          query.cursor = { id: cursor };
          (query as any).skip = 1;
        }
  
        // 🔹 타입 우회 (런타임에는 _count가 들어있음)
        const users = await prisma.user.findMany(query as any);
  
        let nextCursor: string | null = null;
        if (users.length > take) {
          const last = users.pop()!;
          nextCursor = last.id;
        }
  
        return res.json({
          ok: true,
          items: users.map((u: any) => ({
            id: u.id,
            email: u.email,
            username: u.username,
            ctiType: u.ctiType,
            // 🔹 전체 댓글 수(이슈 댓글 + 아젠다 댓글) 합산
            commentsCount:
              (u._count?.comments ?? 0) + (u._count?.issueComments ?? 0),
            // 🔹 전체 투표/좋아요 성격 액션 합산
            votesCount:
              (u._count?.likes ?? 0) +
              (u._count?.issueCommentLikes ?? 0) +
              (u._count?.votes ?? 0),
            // 🔹 status 없으면 기본 ACTIVE (Prisma enum 그대로 사용)
            status: (u.status ?? UserStatus.ACTIVE) as UserStatus,
            joinedAt: u.createdAt,
          })),
          nextCursor,
        });
      } catch (e) {
        console.error("GET /api/admin/users error", e);
        return res
          .status(500)
          .json({ ok: false, error: "INTERNAL_ERROR" });
      }
    }
  );

adminIssueRoutes.get(
  "/people",
  requireAuth,
  adminAuth,
  async (_req: Request, res: Response) => {
    return res.json({ items: [], nextCursor: null });
  }
);

adminIssueRoutes.get(
  "/reports",
  requireAuth,
  adminAuth,
  async (_req: Request, res: Response) => {
    return res.json({ items: [], nextCursor: null });
  }
);

  


/* ─────────────────────────────────────────────
   9. Articles 검색 (IssuesTab "전체 기사" 탭용)
   GET /api/admin/articles/search?q=...
───────────────────────────────────────────── */
adminIssueRoutes.get(
    "/articles/search",
    requireAuth,
    adminAuth,
    async (req: Request, res: Response) => {
      const q = (req.query.q as string | undefined)?.trim() ?? "";
      const take = Math.min(parseInt((req.query.take as string) ?? "1000", 10), 1000);
        // 전체 기사 탭 개수 제한
      try {
        const where: any = {
          url: { not: "" },
        };
  
        if (q) {
          where.OR = [
            { title: { contains: q } },
            { text:  { contains: q } },
            { outlet:{ contains: q } },
          ];
        }
  
        const rows = await prisma.rawArticle.findMany({
          where,
          take,
          orderBy: {
            publishedAt: "desc",
          },
          select: {
            id: true,
            outlet: true,
            url: true,
            title: true,
            publishedAt: true,
            text: true,
            side: true,
          },
        });
  
        const items = rows.map((r) => {
            const url = r.url ?? "";
            return {
              id: url || String(r.id), // ✅ ID = URL 우선
              title: r.title ?? "(제목 없음)",
              source: r.outlet ?? "언론",
              date: r.publishedAt
                ? r.publishedAt.toISOString().slice(0, 10)
                : "",
              url,
              summary: (r.text ?? "").slice(0, 300),
              side: r.side ?? "center",
              keywords: [] as string[],
            };
          });
  
        res.json({ ok: true, items, nextCursor: null });
      } catch (e) {
        console.error("[admin/articles/search] error:", e);
        res.status(500).json({ error: "SEARCH_ERROR" });
      }
    }
  );

/* ─────────────────────────────────────────────
   10. 이슈 AI 제목/요약 재생성
   POST /api/admin/issues/:id/refresh-summary
───────────────────────────────────────────── */
adminIssueRoutes.post(
  "/issues/:id/refresh-summary",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const issue = await prisma.issue.findUnique({
        where: { id },
        include: { sources: true },
      });

      if (!issue) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      // ✅ 이미 사람이 손댄 값이면 재생성하지 않도록 체크
      const hasTitle =
        (issue.title ?? "").trim().length > 0 &&
        (issue.title ?? "").trim() !== "(제목 없음)";
      const hasSummary = (issue.summary ?? "").trim().length > 0;

      let newTitle: string | undefined;
      let newSummary: string | undefined;

      // 🔹 제목이 비어 있을 때만 생성
      if (!hasTitle) {
        try {
          const aiTitle = await generateIssueTitle(issue as any);
          if (aiTitle?.trim()?.length) {
            newTitle = aiTitle.trim();
          }
        } catch (e) {
          console.error("[refresh-summary] 제목 생성 실패:", e);
        }
      }

      // 🔹 요약이 비어 있을 때만 생성
      if (!hasSummary) {
        try {
          const aiSummary = await generateIssueSummary(issue as any);
          if (aiSummary?.trim()?.length) {
            newSummary = aiSummary.trim();
          }
        } catch (e) {
          console.error("[refresh-summary] 요약 생성 실패:", e);
        }
      }

      if (!newTitle && !newSummary) {
        // 생성할 게 없으면 그대로 반환
        return res.json({ ok: true, item: issue });
      }

      const updated = await prisma.issue.update({
        where: { id },
        data: {
          ...(newTitle ? { title: newTitle } : {}),
          ...(newSummary ? { summary: newSummary } : {}),
        },
      });

      return res.json({ ok: true, item: updated });
    } catch (err) {
      console.error("refresh-summary error:", err);
      return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
    }
  }
);


/* ─────────────────────────────────────────────
   11. 좌/우 언론 요약 자동 생성
   POST /api/admin/issues/:id/refresh-side-summary
───────────────────────────────────────────── */
adminIssueRoutes.post(
  "/issues/:id/refresh-side-summary",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const issue = await prisma.issue.findUnique({
        where: { id },
        include: { sources: true },
      });

      if (!issue) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      const hasLeft = (issue.leftSummary ?? "").trim().length > 0;
      const hasRight = (issue.rightSummary ?? "").trim().length > 0;

      let newLeft: string | undefined;
      let newRight: string | undefined;

      // 🔹 진보 요약이 비어 있을 때만 생성
      if (!hasLeft) {
        try {
          const leftSummary = await generateSideSummary(issue.id, "left");
          if (leftSummary?.trim()?.length) {
            newLeft = leftSummary.trim();
          }
        } catch (e) {
          console.error("[refresh-side-summary] left 생성 실패:", e);
        }
      }

      // 🔹 보수 요약이 비어 있을 때만 생성
      if (!hasRight) {
        try {
          const rightSummary = await generateSideSummary(issue.id, "right");
          if (rightSummary?.trim()?.length) {
            newRight = rightSummary.trim();
          }
        } catch (e) {
          console.error("[refresh-side-summary] right 생성 실패:", e);
        }
      }

      if (!newLeft && !newRight) {
        // 생성할 게 없으면 기존 이슈 그대로 반환
        return res.json({ ok: true, item: issue });
      }

      const updated = await prisma.issue.update({
        where: { id },
        data: {
          ...(newLeft ? { leftSummary: newLeft } : {}),
          ...(newRight ? { rightSummary: newRight } : {}),
        },
      });

      return res.json({ ok: true, item: updated });
    } catch (err) {
      console.error("refresh-side-summary error:", err);
      return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
    }
  }
);


/* ─────────────────────────────────────────────
   12. 이슈 용어 사전 재생성
   POST /api/admin/issues/:id/refresh-glossary
───────────────────────────────────────────── */
adminIssueRoutes.post(
  "/issues/:id/refresh-glossary",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const updated = await refreshIssueGlossary(id);

      if (!updated) {
        return res
          .status(404)
          .json({ ok: false, error: "NOT_FOUND" });
      }

      // 프론트 GlossaryPage에서 기대하는 형태에 맞춰서 응답
      return res.json({
        ok: true,
        item: {
          glossaryText: updated.glossaryText ?? null,
        },
      });
    } catch (err) {
      console.error(
        "❌ [POST /api/admin/issues/:id/refresh-glossary] error:",
        err
      );
      return res
        .status(500)
        .json({ ok: false, error: "INTERNAL_ERROR" });
    }
  }
);


