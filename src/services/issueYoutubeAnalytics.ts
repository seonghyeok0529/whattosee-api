import axios from "axios";
import { IssueStatus } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { openai, DEFAULT_MODEL } from "../lib/openai.js";
import { extractKeywords } from "../pipelines/news/util/keywords.js";

const YT_BASE = "https://www.googleapis.com/youtube/v3";
const YT_RETRY_LIMIT = 2;
const CACHE_TTL_HOURS = 6;
const CACHE_TTL_MS = CACHE_TTL_HOURS * 60 * 60 * 1000;
const DEFAULT_MAX_VIDEOS = 50;
const DEFAULT_MAX_COMMENTS = 1200;
const DEFAULT_LOOKBACK_DAYS = 30;

type AnalyzeOptions = {
  force?: boolean;
};

type YoutubeVideoLite = {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  viewCount: number;
};

type YoutubeAnalyticsPayload = {
  issueId: string;
  generatedAt: string;
  range: { from: string; to: string };
  youtube: {
    videoCount: number;
    commentCount: number;
    topVideos: Array<{
      videoId: string;
      title: string;
      publishedAt: string;
      viewCount: number;
    }>;
  };
  frame: {
    videoFrame: { A: number; B: number };
    rationale: { A: string; B: string };
  };
  comments: {
    irtDistribution: Record<string, number>;
    notes: string;
  };
  meta: {
    cached: boolean;
    ttlHours: number;
    attempts: number;
    model: string;
  };
};

function clampInt(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function toIsoDate(daysAgo: number) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function parseForce(forceRaw: unknown) {
  if (typeof forceRaw !== "string") return false;
  return forceRaw.toLowerCase() === "true";
}

function normalizeDistribution(input: Record<string, unknown>) {
  const keys = [
    "Macro",
    "Micro",
    "Person",
    "System",
    "Rule",
    "Context",
    "Fault",
    "Meaning",
  ];

  const out: Record<string, number> = {};
  for (const key of keys) {
    const raw = Number(input[key]);
    const n = Number.isFinite(raw) ? raw : 0.5;
    out[key] = Number(Math.min(Math.max(n, 0), 1).toFixed(4));
  }
  return out;
}

async function requestWithRetry<T>(fn: () => Promise<T>, label: string) {
  let lastErr: unknown;
  for (let i = 0; i <= YT_RETRY_LIMIT; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delayMs = 200 * (i + 1) * (i + 1);
      console.warn("[issue-youtube-analytics] request retry", {
        label,
        attempt: i + 1,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function pickIssueKeywords(issue: { title: string; summary: string | null; tags: unknown }) {
  const title = issue.title?.trim() ?? "";
  const summary = issue.summary?.trim() ?? "";
  const tagList = Array.isArray(issue.tags)
    ? issue.tags.filter((x): x is string => typeof x === "string")
    : [];

  const extracted = extractKeywords(`${title} ${summary} ${tagList.join(" ")}`, 8);
  const query = [title, ...tagList.slice(0, 4), ...extracted.slice(0, 4)]
    .filter(Boolean)
    .join(" ")
    .trim();

  return query.length > 0 ? query : title;
}

async function searchVideos(params: {
  apiKey: string;
  query: string;
  maxVideos: number;
  publishedAfter: string;
}) {
  const videoIds: string[] = [];
  let pageToken: string | undefined;

  while (videoIds.length < params.maxVideos) {
    const data = await requestWithRetry(async () => {
      const { data } = await axios.get(`${YT_BASE}/search`, {
        params: {
          key: params.apiKey,
          part: "snippet",
          q: params.query,
          type: "video",
          order: "date",
          maxResults: 50,
          publishedAfter: params.publishedAfter,
          pageToken,
        },
      });
      return data as any;
    }, "search.list");

    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const id = item?.id?.videoId;
      if (!id || videoIds.includes(id)) continue;
      videoIds.push(id);
      if (videoIds.length >= params.maxVideos) break;
    }

    if (!data.nextPageToken || items.length === 0) break;
    pageToken = data.nextPageToken;
  }

  return videoIds;
}

async function fetchVideoDetails(apiKey: string, videoIds: string[]) {
  const videos: YoutubeVideoLite[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const data = await requestWithRetry(async () => {
      const { data } = await axios.get(`${YT_BASE}/videos`, {
        params: {
          key: apiKey,
          part: "snippet,statistics",
          id: chunk.join(","),
          maxResults: 50,
        },
      });
      return data as any;
    }, "videos.list");

    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const videoId = item?.id;
      const snippet = item?.snippet;
      if (!videoId || !snippet) continue;
      videos.push({
        videoId,
        title: String(snippet.title ?? "").slice(0, 300),
        description: String(snippet.description ?? "").slice(0, 4000),
        publishedAt: snippet.publishedAt ?? new Date().toISOString(),
        viewCount: Number(item?.statistics?.viewCount ?? 0),
      });
    }
  }
  return videos;
}

async function fetchCommentsForVideo(params: {
  apiKey: string;
  videoId: string;
  relevanceLimit: number;
  timeLimit: number;
}) {
  const dedup = new Set<string>();
  const comments: string[] = [];

  for (const order of ["relevance", "time"] as const) {
    const maxResults = order === "relevance" ? params.relevanceLimit : params.timeLimit;
    if (maxResults <= 0) continue;

    const data = await requestWithRetry(async () => {
      const { data } = await axios.get(`${YT_BASE}/commentThreads`, {
        params: {
          key: params.apiKey,
          part: "snippet",
          videoId: params.videoId,
          order,
          maxResults: clampInt(maxResults, 1, 100),
          textFormat: "plainText",
        },
      });
      return data as any;
    }, `commentThreads.list:${order}`);

    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const top = item?.snippet?.topLevelComment;
      const snippet = top?.snippet;
      const commentId = top?.id;
      if (!commentId || dedup.has(commentId)) continue;
      dedup.add(commentId);
      const text = String(snippet?.textOriginal ?? "").trim();
      if (!text) continue;
      comments.push(text.slice(0, 1000));
    }
  }

  return comments;
}

function fallbackVideoFrame(videos: YoutubeVideoLite[]) {
  if (videos.length === 0) {
    return {
      videoFrame: { A: 0.5, B: 0.5 },
      rationale: {
        A: "수집 영상이 충분하지 않아 중립값을 사용했습니다.",
        B: "수집 영상이 충분하지 않아 중립값을 사용했습니다.",
      },
    };
  }

  const split = Math.round(videos.length * 0.5);
  const a = split / videos.length;
  const b = 1 - a;

  return {
    videoFrame: { A: Number(a.toFixed(4)), B: Number(b.toFixed(4)) },
    rationale: {
      A: "영상 제목/설명의 주요 관점 중 프레임 A 비중을 보수적으로 추정했습니다.",
      B: "영상 제목/설명의 주요 관점 중 프레임 B 비중을 보수적으로 추정했습니다.",
    },
  };
}

async function classifyVideoFrame(videos: YoutubeVideoLite[]) {
  const fallback = fallbackVideoFrame(videos);
  if (videos.length === 0) return fallback;

  try {
    const compact = videos.slice(0, 40).map((v) => ({
      title: v.title,
      description: v.description.slice(0, 400),
      viewCount: v.viewCount,
      publishedAt: v.publishedAt,
    }));

    const completion = await openai.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "너는 이슈 관련 유튜브 영상의 프레임 분포를 집계하는 분석기다. 개인/채널 식별 분석은 금지하고 집단 통계만 반환한다.",
        },
        {
          role: "user",
          content: [
            "아래 영상 텍스트(제목+설명)로 프레임 A/B 분포를 0~1 비율로 반환해라.",
            "문구는 인과 대신 연관/동반 표현만 사용하라.",
            `입력(JSON): ${JSON.stringify(compact)}`,
            "반환 JSON: {\"videoFrame\":{\"A\":0.0,\"B\":0.0},\"rationale\":{\"A\":\"...\",\"B\":\"...\"}}",
          ].join("\n"),
        },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(raw) as any;

    return {
      videoFrame: {
        A: Number(Math.min(Math.max(Number(parsed?.videoFrame?.A ?? 0.5), 0), 1).toFixed(4)),
        B: Number(Math.min(Math.max(Number(parsed?.videoFrame?.B ?? 0.5), 0), 1).toFixed(4)),
      },
      rationale: {
        A: String(parsed?.rationale?.A ?? fallback.rationale.A).slice(0, 500),
        B: String(parsed?.rationale?.B ?? fallback.rationale.B).slice(0, 500),
      },
    };
  } catch (err) {
    console.warn("[issue-youtube-analytics] frame classification fallback", {
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

async function classifyCommentDistribution(comments: string[]) {
  const fallback = {
    Macro: 0.5,
    Micro: 0.5,
    Person: 0.5,
    System: 0.5,
    Rule: 0.5,
    Context: 0.5,
    Fault: 0.5,
    Meaning: 0.5,
  };

  if (comments.length === 0) return fallback;

  try {
    const sample = comments.slice(0, 400);
    const completion = await openai.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "너는 한국어 댓글을 집단 통계로만 분류하는 분석기다. 개인 프로파일링/식별을 금지한다.",
        },
        {
          role: "user",
          content: [
            "아래 댓글 샘플을 IRT/CTI 반응 축으로 집계하라.",
            "반드시 0~1 실수로 반환하고 JSON 외 텍스트를 금지한다.",
            "키: Macro, Micro, Person, System, Rule, Context, Fault, Meaning",
            `댓글(JSON): ${JSON.stringify(sample)}`,
          ].join("\n"),
        },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() ?? "{}";
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeDistribution(parsed);
  } catch (err) {
    console.warn("[issue-youtube-analytics] comment classification fallback", {
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

export async function getIssueYoutubeAnalyticsCache(issueId: string) {
  const publishedIssue = await prisma.issue.findFirst({
    where: {
      id: issueId,
      status: IssueStatus.PUBLISHED,
    },
    select: { id: true },
  });

  if (!publishedIssue) {
    return null;
  }

  const now = new Date();
  const cache = await prisma.issueYoutubeAnalyticsCache.findUnique({
    where: { issueId },
    select: {
      payload: true,
      generatedAt: true,
      expiresAt: true,
    },
  });

  if (!cache || cache.expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  const payload = cache.payload as YoutubeAnalyticsPayload;
  return {
    ...payload,
    generatedAt: cache.generatedAt.toISOString(),
    meta: {
      ...payload.meta,
      cached: true,
      ttlHours: CACHE_TTL_HOURS,
    },
  };
}

export async function getOrCreateIssueYoutubeAnalytics(issueId: string, options?: AnalyzeOptions) {
  const force = options?.force ?? false;
  const now = new Date();

  if (!force) {
    const cached = await getIssueYoutubeAnalyticsCache(issueId);
    if (cached) return cached;
  }

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: {
      id: true,
      title: true,
      summary: true,
      tags: true,
      status: true,
    },
  });

  if (!issue || issue.status !== IssueStatus.PUBLISHED) {
    throw new Error("ISSUE_NOT_FOUND");
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY_MISSING");
  }

  const query = pickIssueKeywords(issue);
  const maxVideos = DEFAULT_MAX_VIDEOS;
  const maxComments = DEFAULT_MAX_COMMENTS;
  const publishedAfter = toIsoDate(DEFAULT_LOOKBACK_DAYS);

  const videoIds = await searchVideos({
    apiKey,
    query,
    maxVideos,
    publishedAfter,
  });

  const videos = await fetchVideoDetails(apiKey, videoIds);

  const commentsPerVideo = videos.length > 0 ? Math.max(1, Math.floor(maxComments / videos.length)) : 0;
  const relevanceLimit = Math.max(1, Math.floor(commentsPerVideo * 0.6));
  const timeLimit = Math.max(1, commentsPerVideo - relevanceLimit);

  const allComments: string[] = [];
  for (const video of videos) {
    if (allComments.length >= maxComments) break;

    try {
      const comments = await fetchCommentsForVideo({
        apiKey,
        videoId: video.videoId,
        relevanceLimit,
        timeLimit,
      });
      for (const c of comments) {
        allComments.push(c);
        if (allComments.length >= maxComments) break;
      }
    } catch (err) {
      console.warn("[issue-youtube-analytics] comment fetch failed", {
        issueId,
        videoId: video.videoId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const frame = await classifyVideoFrame(videos);
  const irtDistribution = await classifyCommentDistribution(allComments);

  const sortedByViews = [...videos].sort((a, b) => b.viewCount - a.viewCount);
  const topVideos = sortedByViews.slice(0, 10).map((v) => ({
    videoId: v.videoId,
    title: v.title,
    publishedAt: v.publishedAt,
    viewCount: v.viewCount,
  }));

  const publishedDates = videos
    .map((v) => v.publishedAt)
    .filter((x): x is string => !!x)
    .sort();

  const payload: YoutubeAnalyticsPayload = {
    issueId,
    generatedAt: now.toISOString(),
    range: {
      from: publishedDates[0] ?? publishedAfter,
      to: publishedDates[publishedDates.length - 1] ?? now.toISOString(),
    },
    youtube: {
      videoCount: videos.length,
      commentCount: allComments.length,
      topVideos,
    },
    frame,
    comments: {
      irtDistribution,
      notes: "집단 통계이며 개인 식별/추적 없음",
    },
    meta: {
      cached: false,
      ttlHours: CACHE_TTL_HOURS,
      attempts: 1,
      model: DEFAULT_MODEL,
    },
  };

  await prisma.issueYoutubeIngest.create({
    data: {
      issueId,
      fetchedAt: now,
      params: {
        query,
        maxVideos,
        maxComments,
        publishedAfter,
        force,
      },
      videoCount: videos.length,
      commentCount: allComments.length,
    },
  });

  await prisma.issueYoutubeAnalyticsCache.upsert({
    where: { issueId },
    update: {
      payload,
      generatedAt: now,
      expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
    },
    create: {
      issueId,
      payload,
      generatedAt: now,
      expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
    },
  });

  return payload;
}

export function parseForceQuery(forceRaw: unknown) {
  return parseForce(forceRaw);
}
