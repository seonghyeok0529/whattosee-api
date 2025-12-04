// src/routes/issues.ts
import { Router } from "express";
import prisma from "../lib/prisma.js";
import { IssueStatus, type SourceSide } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { getOrCreateIssueSummary } from "../services/issueSummary.js";
import { generateSideSummary } from "@/services/generateSideSummary.js";
import { OpenAI } from "openai";

export const issuesRouter = Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/** 주요 언론 화이트리스트(원하는 대로 추가/수정) */
const MAJOR_OUTLETS = new Set<string>([
  "연합뉴스",
  "한겨레",
  "경향신문",
  "오마이뉴스",
  "조선일보",
  "중앙일보",
  "동아일보",
  "JTBC",
  "KBS",
  "MBC",
  "SBS",
]);

type SimpleSource = {
  outlet: string;
  side: SourceSide;
  createdAt?: Date | null;
};

type SimplePerson = {
  id: string;
  name: string;
  role: string | null;
};

type IssueListItem = {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  updatedAt: string;
  leftSources: string[];
  rightSources: string[];
  firstSource?: string;
  thumbnailUrl: string | null;
};

/** 유니크 보장 + 정렬 + 상한 */
function uniqueTop(
  items: SimpleSource[],
  side: SourceSide,
  limit: number
): string[] {
  const seen = new Set<string>();
  const picked: string[] = [];

  items
    .filter((s: SimpleSource) => s.side === side)
    .sort(
      (a: SimpleSource, b: SimpleSource) =>
        (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
    )
    .forEach((s: SimpleSource) => {
      const name = s.outlet?.trim();
      if (!name) return;
      // “주요 언론만” 보여주려면 MAJOR_OUTLETS 체크 추가 가능
      // if (!MAJOR_OUTLETS.has(name)) return;
      if (!seen.has(name)) {
        seen.add(name);
        picked.push(name);
      }
    });

  return picked.slice(0, limit);
}

/** 최초 보도(가장 이른 createdAt)한 언론 */
function firstSourceName(items: { outlet: string; createdAt?: Date | null }[]) {
  if (!items.length) return undefined;

  const sorted = items
    .filter((x) => !!x.outlet)
    .sort(
      (
        a: { outlet: string; createdAt?: Date | null },
        b: { outlet: string; createdAt?: Date | null }
      ) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
    );

  return sorted[0]?.outlet;
}

/** Issue + sources → 리스트에서 쓰는 공통 형태로 변환 */
function toIssueListItem(
  i: {
    id: string;
    title: string;
    summary: string | null;
    tags: any;
    createdAt: Date;
    updatedAt: Date;
    thumbnailUrl: string | null;
  },
  srcs: SimpleSource[]
): IssueListItem {
  const leftSources = uniqueTop(srcs, "left", 4);
  const rightSources = uniqueTop(srcs, "right", 4);
  const firstSource = firstSourceName(srcs);
  const latest = srcs
    .map((s: SimpleSource) => s.createdAt?.getTime() ?? 0)
    .reduce((a: number, b: number) => Math.max(a, b), 0);

  return {
    id: i.id,
    title: i.title,
    summary: i.summary ?? "",
    tags: Array.isArray(i.tags) ? (i.tags as string[]) : [],
    updatedAt: latest
      ? new Date(latest).toISOString()
      : i.updatedAt.toISOString(),
    leftSources,
    rightSources,
    firstSource,
    thumbnailUrl: i.thumbnailUrl ?? null,
  };
}

/**
 * GET /api/issues/top-today
 * 오늘의 TOP 이슈 (서버 랭킹)
 * ※ /:id 보다 위에 둬야 라우팅이 안 잡아먹힘
 */
issuesRouter.get("/top-today", async (_req, res) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const raw = await prisma.issue.findMany({
      where: {
        createdAt: { gte: start, lte: end },
        status: IssueStatus.PUBLISHED, // ✅ 공개 이슈만
      },
      select: {
        id: true,
        title: true,
        summary: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
        thumbnailUrl: true, // 🔹 썸네일 필드
        sources: {
          select: {
            outlet: true,
            side: true,
            createdAt: true,
          },
        },
      },
    });

    const scored = raw.map((i) => {
      const srcs = i.sources as SimpleSource[];

      // 공통 리스트 형태로 변환
      const base = toIssueListItem(
        {
          id: i.id,
          title: i.title,
          summary: i.summary,
          tags: i.tags,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
          thumbnailUrl: i.thumbnailUrl,
        },
        srcs
      );

      // 기존 점수 계산 로직 유지
      const total = srcs.length;
      const left = srcs.filter((s) => s.side === "left").length;
      const right = srcs.filter((s) => s.side === "right").length;
      const diversity = (left > 0 ? 1 : 0) + (right > 0 ? 1 : 0);
      const score = total + diversity * 1.5;

      return {
        ...base,
        score,
      };
    });

    const ranked = scored.sort((a, b) => b.score - a.score).slice(0, 5);

    res.json(ranked);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load top issues" });
  }
});

/**
 * GET /api/issues?cursor=uuid&take=20
 * 리스트: 공개(PUBLISHED) 이슈만
 */
issuesRouter.get("/", async (req, res) => {
  const take = Math.min(Number(req.query.take ?? 50), 1000);
  const cursor = req.query.cursor as string | undefined;

  const raw = await prisma.issue.findMany({
    where: {
      status: IssueStatus.PUBLISHED, // ✅ 공개 이슈만
    },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: {
      id: true,
      title: true,
      summary: true,
      tags: true,
      createdAt: true,
      updatedAt: true,
      thumbnailUrl: true, // 🔹 썸네일 필드
      sources: {
        orderBy: { createdAt: "asc" },
        select: {
          outlet: true,
          side: true,
          createdAt: true,
        },
      },
    },
  });

  const items: IssueListItem[] = raw.map((i) =>
    toIssueListItem(
      {
        id: i.id,
        title: i.title,
        summary: i.summary,
        tags: i.tags,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        thumbnailUrl: i.thumbnailUrl,
      },
      i.sources as SimpleSource[]
    )
  );

  const hasNext = items.length > take;
  const sliced = hasNext ? items.slice(0, take) : items;
  const nextCursor = hasNext ? raw[take].id : null;

  res.json({ items: sliced, nextCursor });
});

/**
 * GET /api/issues/:id
 * 상세: 공개(PUBLISHED) 이슈만
 */
issuesRouter.get("/:id", async (req, res) => {
  const issue = await prisma.issue.findFirst({
    where: {
      id: req.params.id,
      status: IssueStatus.PUBLISHED, // ✅ 비공개 이슈는 404
    },
    select: {
      id: true,
      title: true,
      summary: true,
      leftSummary: true,
      rightSummary: true,
      tags: true,
      createdAt: true,
      updatedAt: true,
      body: true,
      thumbnailUrl: true, // 🔹 상세에서도 썸네일 제공
      sources: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          outlet: true,
          title: true,
          url: true,
          side: true,
          createdAt: true,
        },
      },
      persons: {
        select: { id: true, name: true, role: true },
      },
      relatedFrom: {
        include: {
          to: {
            select: {
              id: true,
              title: true,
              summary: true,
              thumbnailUrl: true,
              status: true,
              updatedAt: true,
            },
          },
        },
      },
      relatedTo: {
        include: {
          from: {
            select: {
              id: true,
              title: true,
              summary: true,
              thumbnailUrl: true,
              status: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });

  if (!issue) return res.status(404).json({ error: "NOT_FOUND" });

  const rawSrcs = issue.sources as any[];
  const persons = issue.persons as SimplePerson[];

  // 🔥 1) 이 이슈의 기사 URL 목록
  const urls = rawSrcs
    .map((s) => s.url as string | null)
    .filter((u): u is string => !!u);

  // 🔥 2) RawArticle 에서 썸네일 + 발행 시각 매핑
  const thumbMap = new Map<string, string | null>();
  const publishedMap = new Map<string, string | null>();

  if (urls.length > 0) {
    const raws = await prisma.rawArticle.findMany({
      where: { url: { in: urls } },
      select: { url: true, thumbnail: true, publishedAt: true },
    });
    for (const r of raws) {
      thumbMap.set(r.url, r.thumbnail ?? null);
      publishedMap.set(
        r.url,
        r.publishedAt ? r.publishedAt.toISOString() : null
      );
    }
  }

  // left/right 소스 계산용 SimpleSource
  const simpleSrcs: SimpleSource[] = rawSrcs.map((s) => ({
    outlet: s.outlet,
    side: s.side,
    createdAt: s.createdAt,
  }));

  const leftSources = uniqueTop(simpleSrcs, "left", 6);
  const rightSources = uniqueTop(simpleSrcs, "right", 6);
  const firstSource = firstSourceName(simpleSrcs);
  const latest = simpleSrcs
    .map((s: SimpleSource) => s.createdAt?.getTime() ?? 0)
    .reduce((a: number, b: number) => Math.max(a, b), 0);

  const relatedMap = new Map<string, any>();

  // 내가 FROM(상위/원 이슈) → 상대가 TO
  for (const r of (issue as any).relatedFrom ?? []) {
    const other = r.to;
    if (!other) continue;
    if (other.status !== IssueStatus.PUBLISHED) continue;

    if (!relatedMap.has(other.id)) {
      relatedMap.set(other.id, {
        id: other.id,
        title: other.title,
        summary: other.summary ?? "",
        thumbnailUrl: other.thumbnailUrl ?? null,
        direction: "from" as const, // 이 이슈에서 출발해서 이어지는(파생) 느낌
        updatedAt: other.updatedAt?.toISOString?.() ?? null,
      });
    }
  }

  // 내가 TO(파생/후속 이슈) ← 상대가 FROM
  for (const r of (issue as any).relatedTo ?? []) {
    const other = r.from;
    if (!other) continue;
    if (other.status !== IssueStatus.PUBLISHED) continue;

    if (!relatedMap.has(other.id)) {
      relatedMap.set(other.id, {
        id: other.id,
        title: other.title,
        summary: other.summary ?? "",
        thumbnailUrl: other.thumbnailUrl ?? null,
        direction: "to" as const, // 이 이슈로 이어지는 상위/원 이슈 느낌
        updatedAt: other.updatedAt?.toISOString?.() ?? null,
      });
    }
  }

  const relatedIssues = Array.from(relatedMap.values());

  res.json({
    issue: {
      id: issue.id,
      title: issue.title,
      summary: issue.summary ?? "",
      leftSummary: issue.leftSummary ?? "",
      rightSummary: issue.rightSummary ?? "",
      tags: Array.isArray(issue.tags) ? (issue.tags as string[]) : [],
      body: issue.body ?? "",
      updatedAt: latest
        ? new Date(latest).toISOString()
        : issue.updatedAt.toISOString(),
      leftSources,
      rightSources,
      firstSource,
      thumbnailUrl: issue.thumbnailUrl ?? null, // 🔹 상세 상단 이미지용
      // 🔥 3) 기사 리스트용 소스 + 썸네일/발행일 포함
      sources: rawSrcs.map((s) => {
        const thumb = thumbMap.get(s.url) ?? null;
        const publishedAt = publishedMap.get(s.url) ?? null;
        return {
          id: s.id,
          outlet: s.outlet,
          title: s.title,
          url: s.url,
          side: s.side,
          createdAt: s.createdAt
            ? (s.createdAt instanceof Date
                ? s.createdAt.toISOString()
                : s.createdAt)
            : null,
          publishedAt, // ⬅️ 추가
          thumbnail: thumb,
          thumbnailUrl: thumb,
        };
      }),
      persons: persons.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
      })),
      relatedIssues,
    },
  });
});

issuesRouter.get("/:id/side-summary", async (req, res) => {
  try {
    const { id } = req.params;
    const sideParam = String(req.query.side || "left").toLowerCase();
    const side: "left" | "right" = sideParam === "right" ? "right" : "left";

    const issue = await prisma.issue.findUnique({
      where: { id },
      select: {
        leftSummary: true,
        rightSummary: true,
      },
    });

    if (!issue) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const summary =
      side === "left" ? issue.leftSummary : issue.rightSummary;

    if (!summary || summary.trim().length === 0) {
      return res.status(404).json({
        ok: false,
        error: "SUMMARY_NOT_READY",
      });
    }

    return res.json({
      ok: true,
      side,
      summary,
      cached: true,
    });
  } catch (e: any) {
    console.error("GET /issues/:id/side-summary error", e);
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_ERROR",
      detail: String(e?.message ?? e),
    });
  }
});

// Fact check (placeholder)
issuesRouter.get("/:id/fact-check", async (_req, res) => {
  res.json({ items: [] });
});

// Glossary (OpenAI 기반 용어 사전)
issuesRouter.get("/:id/glossary", async (req, res) => {
  try {
    const { id } = req.params;

    const issue = await prisma.issue.findUnique({
      where: { id },
      select: {
        title: true,
        summary: true,
        body: true,
        tags: true,
      },
    });

    if (!issue) {
      return res.status(404).json({ error: "NOT_FOUND" });
    }

    const tags = Array.isArray(issue.tags)
      ? (issue.tags as any[]).filter((t) => typeof t === "string")
      : [];

    const contextParts: string[] = [];
    if (issue.title) contextParts.push(issue.title);
    if (issue.summary) contextParts.push(issue.summary);
    if (issue.body) contextParts.push(String(issue.body).slice(0, 800));

    const contextText = contextParts.join("\n\n");

    const prompt = `
너는 한국어로 정치·사회 이슈를 설명하는 "용어 사전" 편집자이다.

아래는 어떤 뉴스 이슈에 대한 정보이다.

[이슈 제목]
${issue.title}

[이슈 요약/본문 일부]
${contextText || "(요약/본문 없음)"}

[관련 키워드(tags)]
${tags.join(", ") || "(태그 없음)"}

이 정보를 바탕으로, 이 이슈를 이해하는 데 중요하지만
일반 시민이 직관적으로 이해하기 어려울 법한 용어만 골라라.

다음 규칙을 지켜서 JSON 배열을 만들어라.

1. 최대 5개 용어만 선택한다. (적어도 1개 이상)
2. 각 항목은 다음 필드를 가진다:
   - term: 용어 (짧게, 예: "재정건전성")
   - definition: 쉬운 한국어 정의 (두세 문장)
   - example: 실제 정책/상황 예시 (문장 1개 정도)
   - relatedTerms: 같은 맥락의 다른 용어 배열 (예: ["국가채무", "재정수지"])

3. 모든 필드는 한국어로 작성한다.
4. JSON 이외의 텍스트는 절대 쓰지 마라. (설명, 말풍선, 주석 등 금지)
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "너는 한국어 정치·사회 이슈를 쉽게 설명하는 용어 사전 편집자이다. 반드시 JSON 배열만 출력한다.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });

    const rawContent = completion.choices[0]?.message?.content ?? "[]";

    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      console.error("[Glossary] JSON parse error:", e, "raw:", rawContent);
      parsed = [];
    }

    const items =
      Array.isArray(parsed)
        ? parsed
            .filter(
              (x) => x && typeof x.term === "string" && typeof x.definition === "string"
            )
            .map((x) => ({
              term: x.term,
              definition: x.definition,
              example: typeof x.example === "string" ? x.example : undefined,
              relatedTerms: Array.isArray(x.relatedTerms)
                ? x.relatedTerms.filter((t: any) => typeof t === "string")
                : undefined,
            }))
        : [];

    const safeItems =
      items.length > 0
        ? items
        : tags.slice(0, 3).map((t) => ({
            term: t,
            definition: `${t}에 대한 자세한 설명을 준비 중입니다.`,
          }));

    return res.json({ items: safeItems });
  } catch (err) {
    console.error("GET /issues/:id/glossary error", err);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

// Related people (별도 personRef 테이블용)
issuesRouter.get("/:id/people", async (req, res) => {
  const { id } = req.params;
  const persons = await prisma.personRef.findMany({
    where: { issueId: id },
    select: { name: true, role: true },
  });
  res.json({
    items: persons.map((p) => ({
      name: p.name,
      role: p.role ?? "",
    })),
  });
});

// News sources (raw list by side, 그대로 유지해도 됨)
issuesRouter.get("/:id/news-sources", async (req, res) => {
  const { id } = req.params;
  const srcs = await prisma.source.findMany({
    where: { issueId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      outlet: true,
      url: true,
      side: true,
      title: true,
      createdAt: true,
    },
  });
  res.json({
    progressive: srcs.filter((s) => s.side === "left"),
    conservative: srcs.filter((s) => s.side === "right"),
  });
});

// 댓글 삭제
issuesRouter.delete(
  "/:issueId/comments/:commentId",
  requireAuth as any,
  async (req: any, res) => {
    try {
      const { issueId, commentId } = req.params;
      const userId = req.userId;

      const comment = await prisma.issueComment.findUnique({
        where: { id: commentId },
        select: {
          id: true,
          issueId: true,
          userId: true,
          isDeleted: true,
        },
      });

      if (!comment || comment.issueId !== issueId)
        return res.status(404).json({ error: "NOT_FOUND" });
      if (comment.userId !== userId)
        return res.status(403).json({ error: "FORBIDDEN" });
      if (comment.isDeleted) return res.json({ ok: true });

      await prisma.issueComment.update({
        where: { id: commentId },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          content: "[삭제된 댓글입니다]",
        },
      });

      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

// 댓글 신고
issuesRouter.post(
  "/:issueId/comments/:commentId/report",
  requireAuth as any,
  async (req: any, res) => {
    try {
      const { issueId, commentId } = req.params;
      const { reason } = req.body ?? {};
      const userId = req.userId;

      const comment = await prisma.issueComment.findUnique({
        where: { id: commentId },
        select: { id: true, issueId: true },
      });

      if (!comment || comment.issueId !== issueId)
        return res.status(404).json({ error: "NOT_FOUND" });

      const existed = await prisma.commentReport
        .findUnique({
          where: {
            parentType_commentId_userId: {
              parentType: "issue",
              commentId,
              userId,
            },
          } as any,
        })
        .catch(() => null);

      if (existed) return res.status(409).json({ error: "ALREADY_REPORTED" });

      await prisma.$transaction(async (tx) => {
        await tx.commentReport.create({
          data: {
            parentType: "issue",
            commentId,
            userId,
            reason: reason?.slice(0, 500) ?? null,
          },
        });
        await tx.issueComment.update({
          where: { id: commentId },
          data: { reportedCount: { increment: 1 } },
        });
      });

      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default issuesRouter;
