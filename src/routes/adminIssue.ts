// src/routes/adminIssue.ts
import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  IssueStatus,
  Prisma,
  ClusterSuggestionStatus,
  UserStatus,
} from "@prisma/client";
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

type IncomingTalkingPoint = {
  order?: number;
  title: string;
  body: string;
  kind?: string | null;
};

function sanitizeTalkingPoints(items?: IncomingTalkingPoint[] | null) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const cleaned = items
    .filter((i) => i && typeof i.title === "string" && typeof i.body === "string")
    .map((i, idx) => ({
      order: typeof i.order === "number" ? i.order : idx + 1,
      title: String(i.title).slice(0, 100),
      body: String(i.body).slice(0, 800),
      kind: i.kind ? String(i.kind) : "etc",
    }));

  return cleaned.length ? cleaned : null;
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
      where.OR = [{ title: { contains: q } }, { summary: { contains: q } }];
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
      where.OR = [{ title: { contains: q } }, { summary: { contains: q } }];
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

      const minCount =
        typeof minArticles === "number" && minArticles > 0
          ? minArticles
          : 2;

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
   3. 추천 이슈 목록 (IssuesTab "추천 이슈" 탭용)
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
              id: url || String(raw?.id ?? a.id), // ✅ ID = URL
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
   4. 이슈 상세 (관리자용)
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
   5. 이슈 생성 + AI 자동 요약/제목 생성
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
        talkingPoints, // 👈 추가
      } = req.body as {
        title?: string;
        summary?: string;
        status?: string;
        articleIds?: string[];
        keywords?: string[];
        fromSuggestionId?: string | null;
        leftSummary?: string;
        rightSummary?: string;
        talkingPoints?: IncomingTalkingPoint[]; // 👈 추가
      };

      const cleanedTalkingPoints = sanitizeTalkingPoints(talkingPoints);

      // 1) 일단 빈 값이라도 생성
      const issue = await prisma.issue.create({
        data: {
          title: title?.trim() || "(제목 없음)",
          summary: summary?.trim() ?? null,
          tags: Array.isArray(keywords) ? keywords : [],
          status: toIssueStatus(status),
          leftSummary: leftSummary?.trim() ?? null,
          rightSummary: rightSummary?.trim() ?? null,
          ...(cleanedTalkingPoints && {
            talkingPoints: {
              create: cleanedTalkingPoints,
            },
          }),
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
              title: title?.trim()?.length
                ? title.trim() // 사람이 입력한 제목이 있으면 유지
                : aiTitle?.trim()?.length
                ? aiTitle.trim()
                : fullIssue.title,

              summary: summary?.trim()?.length
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
   6. 이슈 수정
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
    const {
      title,
      summary,
      status,
      articleIds,
      keywords,
      leftSummary,
      rightSummary,
      talkingPoints,        // 👈 추가
    } = req.body as {
      title?: string;
      summary?: string;
      status?: string;
      articleIds?: string[];
      keywords?: string[];
      leftSummary?: string;
      rightSummary?: string;
      talkingPoints?: IncomingTalkingPoint[]; // 👈 추가
    };

    try {
      const cleanedTalkingPoints = sanitizeTalkingPoints(talkingPoints);

      const data: Prisma.IssueUpdateInput = {
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
      };

      // 쟁점이 같이 넘어온 경우에만 덮어쓰기
      if (cleanedTalkingPoints) {
        (data as any).talkingPoints = {
          deleteMany: {},
          create: cleanedTalkingPoints,
        };
      }

      const issue = await prisma.issue.update({
        where: { id },
        data,
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
   7. 이슈 등록 해제 (ARCHIVED)
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
   8. 이슈 간 연관 관계 추가/삭제
   POST /api/admin/issues/:id/relations
───────────────────────────────────────────── */
adminIssueRoutes.post(
  "/issues/:id/relations",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const { targetIssueId, relationType, direction } = req.body as {
      targetIssueId?: string;
      relationType?: string;
      direction?: "FROM" | "TO";
    };

    // 기본 검증
    if (!targetIssueId || targetIssueId === id) {
      return res
        .status(400)
        .json({ ok: false, message: "invalid targetIssueId" });
    }

    // direction 에 따라 from/to 뒤집기
    const isToDirection = direction === "TO";

    const link = isToDirection
      ? {
          fromIssueId: targetIssueId,
          toIssueId: id,
        }
      : {
          fromIssueId: id,
          toIssueId: targetIssueId,
        };

    const rel = await prisma.issueRelation.upsert({
      where: {
        fromIssueId_toIssueId: {
          fromIssueId: link.fromIssueId,
          toIssueId: link.toIssueId,
        },
      },
      create: {
        ...link,
        relationType: relationType ?? "RELATED",
      },
      update: {
        relationType: relationType ?? "RELATED",
      },
      include: {
        from: true,
        to: true,
      },
    });

    return res.json({
      ok: true,
      item: {
        relationId: rel.id,
        issueId: id, // 현재 편집중인 이슈
        targetIssueId,
        relationType: rel.relationType,
        direction: (direction ?? "FROM") as "FROM" | "TO",
      },
    });
  }
);

adminIssueRoutes.delete(
  "/issues/:id/relations/:relationId",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    const { relationId } = req.params;

    await prisma.issueRelation
      .delete({
        where: { id: relationId },
      })
      .catch(() => null);

    return res.json({ ok: true });
  }
);

/* ─────────────────────────────────────────────
   9. 유저 / 인물 / 리포트 / 기사 검색 (기존 로직 유지)
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
            OR: [{ email: { contains: q } }, { username: { contains: q } }],
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
              comments: true, // AgendaComment[]
              likes: true, // AgendaLike[]
              issueComments: true, // IssueComment[]
              issueCommentLikes: true, // IssueCommentLike[]
              votes: true, // Vote[]
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
   10. Articles 검색 (IssuesTab "전체 기사" 탭용)
   GET /api/admin/articles/search?q=...
───────────────────────────────────────────── */
adminIssueRoutes.get(
  "/articles/search",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    const q = (req.query.q as string | undefined)?.trim() ?? "";
    const take = Math.min(
      parseInt((req.query.take as string) ?? "1000", 10),
      1000
    );
    // 전체 기사 탭 개수 제한
    try {
      const where: any = {
        url: { not: "" },
      };

      if (q) {
        where.OR = [
          { title: { contains: q } },
          { text: { contains: q } },
          { outlet: { contains: q } },
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
   이슈 생성 전, 기사 리스트 기반 쟁점 리스트 프리뷰
   POST /api/admin/issues/preview-talking-points
───────────────────────────────────────────── */
adminIssueRoutes.post(
  "/issues/preview-talking-points",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const {
        title,
        summary,
        leftSummary,
        rightSummary,
        articleIds,
      } = req.body as {
        title?: string;
        summary?: string;
        leftSummary?: string;
        rightSummary?: string;
        articleIds?: string[];
      };

      if (!Array.isArray(articleIds) || articleIds.length === 0) {
        return res
          .status(400)
          .json({ ok: false, error: "articleIds must be a non-empty array" });
      }

      // 🔍 articleIds 는 현재 구조상 URL 이라고 가정 (admin recommended 쪽에서 그렇게 셋팅해놨으니까)
      const urls = Array.from(
        new Set(
          articleIds
            .map((u) => (u ?? "").trim())
            .filter((u) => u.length > 0)
        )
      );

      const raws = await prisma.rawArticle.findMany({
        where: { url: { in: urls } },
        select: {
          outlet: true,
          title: true,
          side: true,
          //text: true,
          publishedAt: true,
        },
      });

      const articlesSummary = raws
        .map((a) => {
          const outlet = a.outlet ?? "언론";
          const t = a.title ?? "(제목 없음)";
          const side =
            a.side === "left"
              ? "진보"
              : a.side === "right"
              ? "보수"
              : "중립";
          const date = a.publishedAt
            ? a.publishedAt.toISOString().slice(0, 10)
            : "";
          return `- [${side}] ${outlet} (${date}) : ${t}`;
        })
        .join("\n");

      const prompt = `
너는 한국어로 인터넷 뉴스 기사 이슈의 핵심 쟁점을 뽑는 에디터야.

아래 정보를 보고, 독자가 이 이슈를 이해할 때
"어디에 집중해서 기사를 읽어야 하는지"를 알려주는 쟁점 리스트를 만들어라.

[이슈 제목]
${title ?? ""}

[이슈 요약]
${summary ?? ""}

[좌/우 요약]
- 진보 요약: ${leftSummary ?? ""}
- 보수 요약: ${rightSummary ?? ""}

[포함된 기사 목록]
${articlesSummary || "(기사 메타 정보 없음)"}

규칙을 지켜라.

1. JSON 배열만 출력한다. (설명 문장, 주석, 마크다운 금지)
2. 각 항목은 다음 필드를 가진다.
   - order: 숫자 (1부터 시작, 정렬용)
   - title: 쟁점 제목 (짧게, 한 줄)
   - body: 이 쟁점이 무엇이고 왜 중요한지 2~3문장으로 설명
   - kind: 아래 중 하나 (문자열)
     * "fact"     : 핵심 사실/배경 정리
     * "conflict" : 갈등·대립 구조
     * "impact"   : 시민/사회에 미치는 영향
     * "future"   : 향후 전개·쟁점
     * "etc"      : 위에 안 들어가면 etc
3. 쟁점은 3~7개 정도로 만든다.
4. 모든 내용은 한국어로 작성한다.
`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "너는 한국 정치·사회 이슈의 쟁점 리스트를 만드는 한국어 에디터이다. 반드시 JSON 배열만 출력한다.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
      });

      const raw = completion.choices[0]?.message?.content ?? "[]";

      let parsed: any[] = [];
      try {
        const tmp = JSON.parse(raw);
        if (Array.isArray(tmp)) parsed = tmp;
      } catch (e) {
        console.error(
          "[issues preview-talking-points] JSON parse error:",
          e,
          "raw=",
          raw
        );
      }

      const talkingPoints = parsed
        .filter(
          (p) =>
            p &&
            typeof p.title === "string" &&
            typeof p.body === "string"
        )
        .slice(0, 7)
        .map((p, idx) => ({
          order: typeof p.order === "number" ? p.order : idx + 1,
          title: String(p.title).slice(0, 100),
          body: String(p.body).slice(0, 800),
          kind: typeof p.kind === "string" ? p.kind : "etc",
        }));

      return res.json({
        ok: true,
        items: talkingPoints,
      });
    } catch (err) {
      console.error(
        "❌ [POST /api/admin/issues/preview-talking-points] error:",
        err
      );
      return res
        .status(500)
        .json({ ok: false, error: "INTERNAL_ERROR" });
    }
  }
);


/* ─────────────────────────────────────────────
   11. 이슈 쟁점 리스트(AI) 재생성
   POST /api/admin/issues/:id/refresh-talking-points
───────────────────────────────────────────── */
adminIssueRoutes.post(
  "/issues/:id/refresh-talking-points",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const issue = await prisma.issue.findUnique({
        where: { id },
        include: {
          sources: true,
        },
      });

      if (!issue) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      // 🔍 기사 메타 + 원문 일부를 컨텍스트로 사용
      const urls = issue.sources
        .map((s) => s.url)
        .filter((u): u is string => !!u && u.trim().length > 0);

      let rawArticles: {
        outlet: string | null;
        title: string | null;
        side: string | null;
        //text: string | null;
        publishedAt: Date | null;
      }[] = [];

      if (urls.length > 0) {
        const raws = await prisma.rawArticle.findMany({
          where: { url: { in: urls } },
          select: {
            outlet: true,
            title: true,
            side: true,
            //text: true,
            publishedAt: true,
          },
        });

        rawArticles = raws;
      }

      const articlesSummary = rawArticles
        .map((a) => {
          const outlet = a.outlet ?? "언론";
          const title = a.title ?? "(제목 없음)";
          const side =
            a.side === "left"
              ? "진보"
              : a.side === "right"
              ? "보수"
              : "중립";
          const date = a.publishedAt
            ? a.publishedAt.toISOString().slice(0, 10)
            : "";
          return `- [${side}] ${outlet} (${date}) : ${title}`;
        })
        .join("\n");

      const prompt = `
너는 한국어로 인터넷 뉴스 기사 이슈의 핵심 쟁점을 뽑는 에디터야.

아래 정보를 보고, 독자가 이 이슈를 이해할 때
"어디에 집중해서 기사를 읽어야 하는지"를 알려주는 쟁점 리스트를 만들어라.

[이슈 제목]
${issue.title ?? ""}

[이슈 요약]
${issue.summary ?? ""}

[좌/우 요약]
- 진보 요약: ${issue.leftSummary ?? ""}
- 보수 요약: ${issue.rightSummary ?? ""}

[포함된 기사 목록]
${articlesSummary || "(기사 메타 정보 없음)"}

규칙을 지켜라.

1. JSON 배열만 출력한다. (설명 문장, 주석, 마크다운 금지)
2. 각 항목은 다음 필드를 가진다.
   - order: 숫자 (1부터 시작, 정렬용)
   - title: 쟁점 제목 (짧게, 한 줄)
   - body: 이 쟁점이 무엇이고 왜 중요한지 2~3문장으로 설명
   - kind: 아래 중 하나 (문자열)
     * "fact"     : 핵심 사실/배경 정리
     * "conflict" : 갈등·대립 구조
     * "impact"   : 시민/사회에 미치는 영향
     * "future"   : 향후 전개·쟁점
     * "etc"      : 위에 안 들어가면 etc
3. 쟁점은 3~7개 정도로 만든다.
4. 모든 내용은 한국어로 작성한다.
`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "너는 한국 정치·사회 이슈의 쟁점 리스트를 만드는 한국어 에디터이다. 반드시 JSON 배열만 출력한다.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
      });

      const raw = completion.choices[0]?.message?.content ?? "[]";

      let parsed: any[] = [];
      try {
        const tmp = JSON.parse(raw);
        if (Array.isArray(tmp)) parsed = tmp;
      } catch (e) {
        console.error(
          "[issues refresh-talking-points] JSON parse error:",
          e,
          "raw=",
          raw
        );
      }

      // 최소 검증/클린업
      const talkingPoints = parsed
        .filter(
          (p) =>
            p &&
            typeof p.title === "string" &&
            typeof p.body === "string"
        )
        .slice(0, 7)
        .map((p, idx) => ({
          order: typeof p.order === "number" ? p.order : idx + 1,
          title: String(p.title).slice(0, 100),
          body: String(p.body).slice(0, 800),
          kind: typeof p.kind === "string" ? p.kind : "etc",
        }));

      // Prisma relation(talkingPoints) 전체 갈아끼우기
      const updated = await prisma.issue.update({
        where: { id },
        data: {
          talkingPoints: {
            deleteMany: {}, // 기존 쟁점 전부 삭제
            create: talkingPoints.map((tp) => ({
              order: tp.order,
              title: tp.title,
              body: tp.body,
              kind: tp.kind,
            })),
          },
        },
        include: {
          talkingPoints: {
            orderBy: { order: "asc" },
          },
        },
      });

      return res.json({
        ok: true,
        items: updated.talkingPoints,
      });
    } catch (err) {
      console.error(
        "❌ [POST /api/admin/issues/:id/refresh-talking-points] error:",
        err
      );
      return res
        .status(500)
        .json({ ok: false, error: "INTERNAL_ERROR" });
    }
  }
);

/**
 * ✏️ 이슈 쟁점 리스트 수동 저장
 * PUT /api/admin/issues/:id/talking-points
 * body: { items: { order?: number; title: string; body: string; kind?: string | null; }[] }
 */
adminIssueRoutes.put(
  "/issues/:id/talking-points",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { items } = req.body as {
        items?: {
          order?: number;
          title: string;
          body: string;
          kind?: string | null;
        }[];
      };

      if (!Array.isArray(items)) {
        return res
          .status(400)
          .json({ ok: false, error: "items must be an array" });
      }

      // 최소 유효성 + 기본값 정리
      const cleaned = items
        .filter((i) => i && typeof i.title === "string" && typeof i.body === "string")
        .map((i, idx) => ({
          order: typeof i.order === "number" ? i.order : idx + 1,
          title: String(i.title).slice(0, 100),
          body: String(i.body).slice(0, 800),
          kind: i.kind ? String(i.kind) : "etc",
        }));

      const updated = await prisma.issue.update({
        where: { id },
        data: {
          talkingPoints: {
            deleteMany: {},      // 기존 쟁점 전부 삭제
            create: cleaned,     // 새 쟁점 전부 생성
          },
        },
        include: {
          talkingPoints: {
            orderBy: { order: "asc" },
          },
        },
      });

      return res.json({
        ok: true,
        items: updated.talkingPoints,
      });
    } catch (err) {
      console.error(
        "❌ [PUT /api/admin/issues/:id/talking-points] error:",
        err
      );
      return res
        .status(500)
        .json({ ok: false, error: "INTERNAL_ERROR" });
    }
  }
);


/* ─────────────────────────────────────────────
   12. 이슈 AI 제목/요약 재생성
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
   13. 좌/우 언론 요약 자동 생성
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
          const leftSummary = await generateSideSummary(id, "left");
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
          const rightSummary = await generateSideSummary(id, "right");
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
   14. 이슈 용어 사전 재생성
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

/* ─────────────────────────────────────────────
   15. 이슈 쟁점 리스트 검증 (원문 기반 fact-check)
   POST /api/admin/issues/:id/validate-talking-points
   - DB에 저장된 talkingPoints 또는 body에서 받은 talkingPoints 기준으로
     기사 원문(text)을 참고해 쟁점의 근거 여부를 평가
───────────────────────────────────────────── */
adminIssueRoutes.post(
  "/issues/:id/validate-talking-points",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const {
        talkingPoints: talkingPointsFromBody,
      } = req.body as {
        talkingPoints?: {
          order?: number;
          title: string;
          body: string;
          kind?: string;
        }[];
      };

      // 1) 이슈 + 연결 기사 + 저장된 쟁점 가져오기
      const issue = await prisma.issue.findUnique({
        where: { id },
        include: {
          sources: true,
          talkingPoints: {
            orderBy: { order: "asc" },
          },
        },
      });

      if (!issue) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      // 2) 검증 대상 쟁점 리스트 결정
      //    - body에 talkingPoints가 오면 그걸 우선 사용 (프론트에서 수정 중인 값 보내줄 수 있음)
      //    - 없으면 DB에 저장된 IssueTalkingPoint 사용
      const baseTalkingPoints =
        Array.isArray(talkingPointsFromBody) && talkingPointsFromBody.length > 0
          ? talkingPointsFromBody
          : issue.talkingPoints.map((tp) => ({
              order: tp.order,
              title: tp.title,
              body: tp.body,
              kind: tp.kind ?? undefined,
            }));

      if (baseTalkingPoints.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "NO_TALKING_POINTS",
          message: "검증할 쟁점 리스트가 없습니다.",
        });
      }

      // 3) 이 이슈에 연결된 기사 URL 기준으로 rawArticle + text 가져오기
      const urls = issue.sources
        .map((s) => s.url)
        .filter((u): u is string => !!u && u.trim().length > 0);

      if (urls.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "NO_ARTICLES",
          message: "연결된 기사(rawArticle)가 없어 검증할 수 없습니다.",
        });
      }

      const raws = await prisma.rawArticle.findMany({
        where: { url: { in: urls } },
        select: {
          url: true,
          outlet: true,
          title: true,
          side: true,
          text: true,
          publishedAt: true,
        },
      });

      if (raws.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "NO_RAW_TEXT",
          message: "연결된 기사 원문(text)이 없어 검증할 수 없습니다.",
        });
      }

      // 4) LLM에 넘길 기사 컨텍스트 구성 (원문 전체 X, 일부만)
      const articleBlocks = raws.map((a, idx) => {
        const outlet = a.outlet ?? "언론";
        const title = a.title ?? "(제목 없음)";
        const side =
          a.side === "left"
            ? "진보"
            : a.side === "right"
            ? "보수"
            : "중립";
        const date = a.publishedAt
          ? a.publishedAt.toISOString().slice(0, 10)
          : "";
        const text = (a.text ?? "").slice(0, 1500); // ✅ 과도한 재현 방지: 앞부분만 잘라서 사용

        return `[#${idx + 1}] [${side}] ${outlet} (${date}) : ${title}
본문 일부:
${text}`;
      });

      const talkingPointsJson = JSON.stringify(baseTalkingPoints, null, 2);

      const prompt = `
너는 한국어 뉴스 기사의 쟁점 리스트를 "사실에 근거했는지" 확인하는 팩트체킹 에디터다.

아래 이슈와 연결된 기사들(원문 일부)과 쟁점 리스트를 보고,
각 쟁점이 기사 내용에 얼마나 근거하는지 평가하라.

[이슈 제목]
${issue.title ?? ""}

[이슈 요약]
${issue.summary ?? ""}

[좌/우 요약]
- 진보 요약: ${issue.leftSummary ?? ""}
- 보수 요약: ${issue.rightSummary ?? ""}

[연결된 기사들(원문 일부)]
${articleBlocks.join("\n\n")}

[검증 대상 쟁점 리스트(JSON)]
${talkingPointsJson}

평가 규칙:

1. 각 쟁점에 대해 다음 중 하나의 verdict를 선택한다.
   - "supported"          : 기사들에서 명확하게 근거를 찾을 수 있음
   - "partially_supported": 일부는 근거가 있지만, 과장/추측/해석이 섞여 있음
   - "not_supported"      : 기사 내용으로는 뒷받침되지 않음
   - "unclear"            : 기사 일부와 관련이 있어 보이지만, 명확하게 판단하기 어려움

2. 각 쟁점마다 다음 정보를 JSON 객체로 반환한다.
   - order: 원래 쟁점의 order (없으면 1부터 순서대로 부여)
   - title: 원래 쟁점 제목
   - verdict: "supported" | "partially_supported" | "not_supported" | "unclear"
   - reason: 한국어로 2~3문장 설명 (어떤 점이 기사와 일치/불일치하는지, 과장 여부 등)
   - suggestion: 선택값. verdict가 "partially_supported" 또는 "not_supported"인 경우,
                 사실에 더 가깝게 다듬은 쟁점 설명(본문)을 제안한다.

3. 기사 원문을 그대로 길게 복사하지 말고,
   핵심 내용만 짧게 요약해서 설명하라.

4. 최종 출력은 JSON 배열만 반환한다. (설명 문장, 마크다운, 주석 금지)
`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "너는 한국 정치·사회 이슈의 쟁점 리스트가 기사 원문에 근거하는지 평가하는 한국어 팩트체킹 에디터이다. 반드시 JSON 배열만 출력한다.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      });

      const raw = completion.choices[0]?.message?.content ?? "[]";

      let parsed: any[] = [];
      try {
        const tmp = JSON.parse(raw);
        if (Array.isArray(tmp)) parsed = tmp;
      } catch (e) {
        console.error(
          "[issues validate-talking-points] JSON parse error:",
          e,
          "raw=",
          raw
        );
      }

      // 최소 검증/클린업
      const results = parsed
        .filter(
          (p) =>
            p &&
            typeof p.title === "string" &&
            typeof p.verdict === "string" &&
            typeof p.reason === "string"
        )
        .map((p, idx) => ({
          order:
            typeof p.order === "number"
              ? p.order
              : baseTalkingPoints[idx]?.order ?? idx + 1,
          title: String(p.title),
          verdict: ["supported", "partially_supported", "not_supported", "unclear"].includes(
            p.verdict
          )
            ? p.verdict
            : "unclear",
          reason: String(p.reason).slice(0, 800),
          suggestion:
            typeof p.suggestion === "string"
              ? String(p.suggestion).slice(0, 800)
              : null,
        }));

      return res.json({
        ok: true,
        items: results,
      });
    } catch (err) {
      console.error(
        "❌ [POST /api/admin/issues/:id/validate-talking-points] error:",
        err
      );
      return res
        .status(500)
        .json({ ok: false, error: "INTERNAL_ERROR" });
    }
  }
);
