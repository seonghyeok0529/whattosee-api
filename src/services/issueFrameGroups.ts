import { z } from "zod";
import prisma from "@/lib/prisma.js";
import { openai, DEFAULT_MODEL } from "@/lib/openai.js";

const FRAME_GROUP_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ARTICLES = 50;
const MAX_ATTEMPTS = 3;

type ArticleLite = {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: string | null;
  summary?: string;
};

type FrameGroupsResponse = {
  issueId: string;
  generatedAt: string;
  groups: { A: ArticleLite[]; B: ArticleLite[] };
  rationale: { A: string; B: string };
  meta: {
    cached: boolean;
    attempts: number;
    model: string;
    articleCount: number;
  };
};

export function shouldUseFrameGroupCache(opts: {
  force: boolean;
  expiresAt: Date | null | undefined;
  now: Date;
}) {
  if (opts.force) return false;
  if (!opts.expiresAt) return false;
  return opts.expiresAt.getTime() > opts.now.getTime();
}

const frameSchema = z.object({
  groups: z.object({
    A: z.array(z.object({ id: z.string() })),
    B: z.array(z.object({ id: z.string() })),
  }),
  rationale: z.object({
    A: z.string().min(1),
    B: z.string().min(1),
  }),
});

function pickArticlesWithDiversity(articles: ArticleLite[], limit = MAX_ARTICLES) {
  if (articles.length <= limit) return articles;

  const byOutlet = new Map<string, ArticleLite[]>();
  for (const article of articles) {
    const key = article.source || "UNKNOWN";
    const bucket = byOutlet.get(key) ?? [];
    bucket.push(article);
    byOutlet.set(key, bucket);
  }

  const sampled: ArticleLite[] = [];
  while (sampled.length < limit) {
    let madeProgress = false;
    for (const [, bucket] of byOutlet) {
      const item = bucket.shift();
      if (!item) continue;
      sampled.push(item);
      madeProgress = true;
      if (sampled.length >= limit) break;
    }
    if (!madeProgress) break;
  }

  return sampled;
}

function buildFallback(articles: ArticleLite[]): Pick<FrameGroupsResponse, "groups" | "rationale"> {
  const groups = { A: [] as ArticleLite[], B: [] as ArticleLite[] };

  const left = articles.filter((a) => a.summary?.includes("[left]"));
  const right = articles.filter((a) => a.summary?.includes("[right]"));

  if (left.length > 0 || right.length > 0) {
    groups.A = left;
    groups.B = right;
  } else {
    articles.forEach((article, idx) => {
      if (idx % 2 === 0) groups.A.push(article);
      else groups.B.push(article);
    });
  }

  if (articles.length > 0 && groups.A.length === 0) groups.A.push(articles[0]);
  if (articles.length > 1 && groups.B.length === 0) groups.B.push(articles[1]);

  return {
    groups,
    rationale: {
      A: "프레임 A: 기사 제목·요약 기반의 책임/해석 초점 분산 휴리스틱",
      B: "프레임 B: 기사 제목·요약 기반의 대안 관점/반대 초점 휴리스틱",
    },
  };
}

function materializeGroupArticles(
  ids: string[],
  articleMap: Map<string, ArticleLite>,
  fallbackPool: ArticleLite[]
) {
  const unique = new Set<string>();
  const out: ArticleLite[] = [];

  for (const id of ids) {
    if (unique.has(id)) continue;
    const article = articleMap.get(id);
    if (!article) continue;
    unique.add(id);
    out.push(article);
  }

  if (out.length === 0 && fallbackPool.length > 0) {
    out.push(fallbackPool[0]);
  }

  return out;
}

function buildPrompt(issueTitle: string, issueSummary: string | null, articles: ArticleLite[]) {
  const compact = articles.map((a, idx) => ({
    no: idx + 1,
    id: a.id,
    source: a.source,
    title: a.title,
    publishedAt: a.publishedAt,
    summary: a.summary ?? "",
  }));

  return [
    "다음 이슈 기사들을 프레임 A/B로 반드시 이분 분류하라.",
    "체인은 내부적으로 다음 순서로 수행한다고 가정하고 결과만 JSON으로 출력하라:",
    "(a) 요약 재사용 또는 3~5문장 보완 요약", 
    "(b) 프레임 단서 추출(책임 귀속/정당성 기준/해석 초점)",
    "(c) A/B 그룹 분류 및 rationale 작성",
    `이슈 제목: ${issueTitle}`,
    `이슈 요약: ${issueSummary ?? ""}`,
    `기사 목록(JSON): ${JSON.stringify(compact)}`,
    "출력 JSON 스키마:",
    JSON.stringify({
      groups: { A: [{ id: "string" }], B: [{ id: "string" }] },
      rationale: { A: "string", B: "string" },
    }),
    "주의: JSON 외 텍스트 금지. 반드시 유효한 JSON만 출력.",
  ].join("\n");
}

export async function classifyWithRetry(
  runModel: (prompt: string) => Promise<string>,
  prompt: string,
  maxAttempts = MAX_ATTEMPTS
) {
  let attempts = 0;
  for (let i = 0; i < maxAttempts; i += 1) {
    attempts += 1;
    const raw = await runModel(prompt);
    try {
      const parsed = JSON.parse(raw);
      return {
        attempts,
        parsed: frameSchema.parse(parsed),
      };
    } catch {
      continue;
    }
  }

  return { attempts, parsed: null };
}

export async function getOrCreateIssueFrameGroups(issueId: string, force = false): Promise<FrameGroupsResponse> {
  const startedAt = Date.now();
  const now = new Date();

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: {
      id: true,
      title: true,
      summary: true,
      sources: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          outlet: true,
          url: true,
          side: true,
          createdAt: true,
        },
      },
      frameGroupCache: {
        select: {
          payload: true,
          attempts: true,
          model: true,
          articleCount: true,
          generatedAt: true,
          expiresAt: true,
        },
      },
    },
  });

  if (!issue) throw new Error("ISSUE_NOT_FOUND");

  if (shouldUseFrameGroupCache({ force, expiresAt: issue.frameGroupCache?.expiresAt, now }) && issue.frameGroupCache) {
    const payload = issue.frameGroupCache.payload as Omit<FrameGroupsResponse, "meta">;
    const response: FrameGroupsResponse = {
      ...payload,
      meta: {
        cached: true,
        attempts: issue.frameGroupCache.attempts,
        model: issue.frameGroupCache.model,
        articleCount: issue.frameGroupCache.articleCount,
      },
    };

    console.info("[issue-frame-groups]", {
      issueId,
      articleCount: response.meta.articleCount,
      cached: true,
      attempts: response.meta.attempts,
      latency: Date.now() - startedAt,
      model: response.meta.model,
    });

    return response;
  }

  const articles = issue.sources.map((s) => ({
    id: s.id,
    title: s.title,
    source: s.outlet,
    url: s.url,
    publishedAt: s.createdAt?.toISOString?.() ?? null,
    summary: `[${s.side}] ${s.title}`,
  }));

  const sampledArticles = pickArticlesWithDiversity(articles, MAX_ARTICLES);
  const articleMap = new Map(sampledArticles.map((a) => [a.id, a]));

  let modelAttempts = 0;
  let modelOutput: z.infer<typeof frameSchema> | null = null;

  if (sampledArticles.length > 0) {
    const prompt = buildPrompt(issue.title, issue.summary, sampledArticles);
    const result = await classifyWithRetry(async (p) => {
      const completion = await openai.chat.completions.create({
        model: DEFAULT_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "너는 JSON 스키마를 엄격히 준수하는 뉴스 프레임 분류기다.",
          },
          { role: "user", content: p },
        ],
      });
      return completion.choices?.[0]?.message?.content?.trim() ?? "";
    }, prompt);

    modelAttempts = result.attempts;
    modelOutput = result.parsed;
  }

  const fallback = buildFallback(sampledArticles);

  const grouped = modelOutput
    ? {
        groups: {
          A: materializeGroupArticles(
            modelOutput.groups.A.map((x) => x.id),
            articleMap,
            fallback.groups.A
          ),
          B: materializeGroupArticles(
            modelOutput.groups.B.map((x) => x.id),
            articleMap,
            fallback.groups.B
          ),
        },
        rationale: modelOutput.rationale,
      }
    : fallback;

  const generatedAt = new Date().toISOString();
  const responseWithoutMeta = {
    issueId,
    generatedAt,
    groups: grouped.groups,
    rationale: grouped.rationale,
  };

  await prisma.issueFrameGroupCache.upsert({
    where: { issueId },
    update: {
      payload: responseWithoutMeta,
      model: DEFAULT_MODEL,
      attempts: modelAttempts,
      articleCount: sampledArticles.length,
      generatedAt: new Date(generatedAt),
      expiresAt: new Date(Date.now() + FRAME_GROUP_TTL_MS),
    },
    create: {
      issueId,
      payload: responseWithoutMeta,
      model: DEFAULT_MODEL,
      attempts: modelAttempts,
      articleCount: sampledArticles.length,
      generatedAt: new Date(generatedAt),
      expiresAt: new Date(Date.now() + FRAME_GROUP_TTL_MS),
    },
  });

  const response: FrameGroupsResponse = {
    ...responseWithoutMeta,
    meta: {
      cached: false,
      attempts: modelAttempts,
      model: DEFAULT_MODEL,
      articleCount: sampledArticles.length,
    },
  };

  console.info("[issue-frame-groups]", {
    issueId,
    articleCount: response.meta.articleCount,
    cached: false,
    attempts: response.meta.attempts,
    latency: Date.now() - startedAt,
    model: response.meta.model,
  });

  return response;
}
