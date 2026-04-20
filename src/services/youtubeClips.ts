// src/services/youtubeClips.ts
import axios from "axios";
import prisma from "../lib/prisma";
import { ArticleStatus, SourceSide } from "@prisma/client";
import OpenAI from "openai";
import crypto from "crypto";

const openai = new OpenAI({
  apiKey: process.env.UPSTAGE_API_KEY,
  baseURL: "https://api.upstage.ai/v1",
});

/* ─────────────────────────────────────────────
   ENV helpers
──────────────────────────────────────────── */
function parseChannelList(envValue?: string): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const PUBLIC_CHANNELS = parseChannelList(process.env.YOUTUBE_PUBLIC_CHANNELS);
const LEFT_CHANNELS = parseChannelList(process.env.YOUTUBE_LEFT_CHANNELS);
const RIGHT_CHANNELS = parseChannelList(process.env.YOUTUBE_RIGHT_CHANNELS);

const YT_API_KEY = process.env.YOUTUBE_API_KEY;

// 채널 → side 매핑
function resolveSide(channelId: string): SourceSide {
  if (LEFT_CHANNELS.includes(channelId)) return "left";
  if (RIGHT_CHANNELS.includes(channelId)) return "right";
  if (PUBLIC_CHANNELS.includes(channelId)) return "center";
  return "neutral";
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function nowPlusMs(ms: number) {
  return new Date(Date.now() + ms);
}

function clampHours(hours: number, min = 1, max = 168) {
  if (!Number.isFinite(hours)) return 24;
  return Math.min(Math.max(hours, min), max);
}

/* ─────────────────────────────────────────────
   DB Job Lock (중복 실행 방지)
   - key 별로 1개만 실행되도록 보장
──────────────────────────────────────────── */
const LOCK_TTL_MS = 15 * 60 * 1000; // 15분
async function ensureLockRow(key: string) {
  // row가 없으면 만들어둠 (race-safe: unique 충돌은 무시)
  try {
    await prisma.jobLock.create({
      data: {
        key,
        lockedUntil: new Date(0),
        runId: null,
      },
    });
  } catch {
    // ignore
  }
}

async function acquireLock(key: string) {
  await ensureLockRow(key);

  const runId = crypto.randomUUID();
  const now = new Date();
  const lockedUntil = nowPlusMs(LOCK_TTL_MS);

  // lockedUntil < now 인 경우에만 락을 획득 (원자적)
  const got = await prisma.jobLock.updateMany({
    where: {
      key,
      lockedUntil: { lt: now },
    },
    data: {
      lockedUntil,
      runId,
    },
  });

  if (got.count !== 1) {
    const row = await prisma.jobLock.findUnique({
      where: { key },
      select: { lockedUntil: true, runId: true },
    });
    const until = row?.lockedUntil?.toISOString?.() ?? "unknown";
    throw new Error(
      `LOCKED:${key} (another run is active; lockedUntil=${until})`
    );
  }

  return { key, runId };
}

async function releaseLock(key: string, runId: string) {
  const now = new Date();
  // 내가 잡은 락만 해제 (runId 매칭)
  await prisma.jobLock.updateMany({
    where: { key, runId },
    data: { lockedUntil: now },
  });
}

/* ─────────────────────────────────────────────
   Channel Cursor (유튜브 API 호출량 줄이기)
   - 채널별 마지막 수집 시각(lastPublishedAt) 저장
   - 다음 수집은 publishedAfter=lastPublishedAt - buffer
──────────────────────────────────────────── */
const CURSOR_BUFFER_MS = 5 * 60 * 1000; // 5분 버퍼(동일 시각/지연 업로드 누락 방지)

async function getChannelCursor(channelId: string) {
  return prisma.youtubeChannelCursor.findUnique({
    where: { channelId },
    select: { channelId: true, lastPublishedAt: true },
  });
}

async function upsertChannelCursor(channelId: string, lastPublishedAt: Date) {
  await prisma.youtubeChannelCursor.upsert({
    where: { channelId },
    create: { channelId, lastPublishedAt },
    update: { lastPublishedAt },
  });
}

/* ─────────────────────────────────────────────
   유튜브 API 호출: 채널별 최근 영상 가져오기
   - publishedAfter 기반 (커서/시간)
──────────────────────────────────────────── */

type FetchChannelClipsOptions = {
  channelId: string;
  publishedAfter: Date; // 필수(커서/시간 계산 결과)
};

type FetchedClip = {
  youtubeId: string;
  title?: string;
  description?: string;
  publishedAt?: Date;
  channelTitle?: string;
  thumbnail?: string;
};

async function fetchChannelClips({
  channelId,
  publishedAfter,
}: FetchChannelClipsOptions): Promise<FetchedClip[]> {
  if (!YT_API_KEY) {
    throw new Error("YOUTUBE_API_KEY가 설정되어 있지 않습니다.");
  }

  const params = {
    key: YT_API_KEY,
    part: "snippet",
    channelId,
    order: "date",
    publishedAfter: publishedAfter.toISOString(),
    maxResults: 50,
    type: "video",
  };

  const url = "https://www.googleapis.com/youtube/v3/search";

  try {
    const { data } = await axios.get(url, { params });
    const items: any[] = (data as any)?.items ?? [];

    return items
      .map((item) => {
        const videoId = item.id?.videoId as string | undefined;
        const snippet = item.snippet ?? {};
        return {
          youtubeId: videoId ?? "",
          title: snippet.title as string | undefined,
          description: snippet.description as string | undefined,
          publishedAt: snippet.publishedAt
            ? new Date(snippet.publishedAt)
            : undefined,
          channelTitle: snippet.channelTitle as string | undefined,
          thumbnail:
            snippet.thumbnails?.high?.url ??
            snippet.thumbnails?.medium?.url ??
            snippet.thumbnails?.default?.url ??
            undefined,
        };
      })
      .filter((c) => !!c.youtubeId);
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      console.error("[YT ERROR]", {
        status: err.response?.status,
        data: err.response?.data,
        url,
        params,
      });
    } else {
      console.error("[YT ERROR unknown]", err);
    }
    throw err;
  }
}

/* ─────────────────────────────────────────────
   1) 유튜브 뉴스 클립 수집 → RawClip 저장
   ✅ 중복 방지 전략
   - (A) 전역 락: 동시 ingest 실행 차단
   - (B) 채널 커서: publishedAfter 최소화(유튜브 API 호출량 감소)
   - (C) DB Unique: RawClip.youtubeId @unique + createMany(skipDuplicates)
──────────────────────────────────────────── */

export async function ingestYoutubeNewsClips(options?: {
  hours?: number; // 커서가 없을 때만 fallback 범위
  useCursor?: boolean; // 기본 true
}) {
  const lock = await acquireLock("youtube_ingest");
  try {
    const useCursor = options?.useCursor ?? true;
    const hours = clampHours(options?.hours ?? 24);

    if (!YT_API_KEY) {
      throw new Error("YOUTUBE_API_KEY가 설정되어 있지 않습니다.");
    }

    const allChannels = uniq([
      ...PUBLIC_CHANNELS,
      ...LEFT_CHANNELS,
      ...RIGHT_CHANNELS,
    ]);

    if (allChannels.length === 0) {
      throw new Error(
        "수집할 유튜브 채널이 없습니다. .env의 YOUTUBE_*_CHANNELS 값을 확인해주세요."
      );
    }

    let fetchedCount = 0;
    let createdCount = 0;
    let skippedCount = 0;

    const errors: { channelId: string; error: string }[] = [];

    // 채널별 수집
    for (const channelId of allChannels) {
      const side = resolveSide(channelId);

      // 1) publishedAfter 계산: (커서가 있으면 커서 기반 / 없으면 hours fallback)
      let publishedAfter: Date;
      try {
        if (useCursor) {
          const cursor = await getChannelCursor(channelId);
          if (cursor?.lastPublishedAt) {
            publishedAfter = new Date(
              cursor.lastPublishedAt.getTime() - CURSOR_BUFFER_MS
            );
          } else {
            publishedAfter = new Date(Date.now() - hours * 60 * 60 * 1000);
          }
        } else {
          publishedAfter = new Date(Date.now() - hours * 60 * 60 * 1000);
        }
      } catch (e) {
        // 커서 조회 실패 시에도 수집은 계속(안전 fallback)
        publishedAfter = new Date(Date.now() - hours * 60 * 60 * 1000);
      }

      try {
        const clips = await fetchChannelClips({ channelId, publishedAfter });
        fetchedCount += clips.length;

        if (clips.length === 0) continue;

        // 2) bulk insert (중복은 DB에서 skip)
        const rows = clips.map((clip) => ({
          youtubeId: clip.youtubeId,
          title: clip.title ?? "(제목 없음)",
          description: clip.description ?? null,
          channel: (clip.channelTitle ?? channelId).trim(),
          side,
          url: `https://www.youtube.com/watch?v=${clip.youtubeId}`,
          thumbnail: clip.thumbnail ?? null,
          publishedAt: clip.publishedAt ?? null,
          status: "FETCHED" as const,
        }));

        const result = await prisma.rawClip.createMany({
          data: rows,
          skipDuplicates: true, // ✅ youtubeId @unique 기반
        });

        createdCount += result.count;
        skippedCount += rows.length - result.count;

        // 3) 커서 업데이트: 이번 응답에서 가장 최신 publishedAt을 저장
        if (useCursor) {
          const maxPub = clips
            .map((c) => c.publishedAt)
            .filter((d): d is Date => !!d)
            .reduce<Date | null>((acc, d) => {
              if (!acc) return d;
              return d.getTime() > acc.getTime() ? d : acc;
            }, null);

          if (maxPub) {
            await upsertChannelCursor(channelId, maxPub);
          }
        }
      } catch (err: any) {
        console.error(
          "[ingestYoutubeNewsClips] 채널 수집 실패:",
          channelId,
          err?.response?.data ?? err?.message ?? err
        );
        errors.push({
          channelId,
          error: err?.message ?? "unknown error",
        });
      }
    }

    console.log(
      `[ingestYoutubeNewsClips] useCursor=${options?.useCursor ?? true}, hours=${hours}, channels=${allChannels.length}, fetched=${fetchedCount}, created=${createdCount}, skipped=${skippedCount}, errors=${errors.length}`
    );

    return {
      useCursor: options?.useCursor ?? true,
      hours,
      channelCount: allChannels.length,
      fetchedCount,
      createdCount,
      skippedCount,
      errors,
    };
  } finally {
    await releaseLock(lock.key, lock.runId);
  }
}

/* ─────────────────────────────────────────────
   2) RawClip → ClipClusterSuggestion (임베딩 기반)
   ✅ 중복 방지 전략
   - (A) 전역 락: 동시 cluster 실행 차단
   - (B) ClipClusterSuggestion.key @unique 유지 + exist 체크
──────────────────────────────────────────── */

export async function clusterYoutubeNewsClips(options?: {
  minGroupSize?: number;
}) {
  const lock = await acquireLock("youtube_cluster");
  try {
    const minGroupSize = options?.minGroupSize ?? 2;

    // 1) 클러스터링 대상 클립 가져오기
    const clips = await prisma.rawClip.findMany({
      where: {
        status: {
          in: [ArticleStatus.FETCHED, ArticleStatus.PARSED],
        },
      },
      orderBy: {
        publishedAt: "desc",
      },
      take: CLIP_MAX_N,
    });

    if (clips.length === 0) {
      return {
        ok: true,
        createdClusterCount: 0,
        clipCount: 0,
      };
    }

    const docs: RawClipLite[] = clips.map((c) => ({
      id: c.id,
      youtubeId: c.youtubeId,
      url: c.url,
      title: c.title,
      description: c.description ?? undefined,
      text: c.text ?? undefined,
      channel: c.channel,
      side: c.side,
      publishedAt: c.publishedAt,
    }));

    // 2) 텍스트 → 임베딩(현재는 메모리 계산)
    const texts = docs.map(clipText);
    const embs = await embedClipBatch(texts);
    const n = embs.length;

    // 3) 유사도 행렬(그래프) 생성
    const adj: Uint8Array[] = Array.from({ length: n }, () => new Uint8Array(n));
    for (let i = 0; i < n; i++) {
      adj[i][i] = 1;
      for (let j = i + 1; j < n; j++) {
        const sim = cosine(embs[i], embs[j]);
        if (sim >= CLIP_SIM_T) {
          adj[i][j] = 1;
          adj[j][i] = 1;
        }
      }
    }

    // 4) 연결요소 → 클러스터 인덱스 집합
    const comps = connectedComponents(adj, n);

    // 5) minGroupSize 이상인 것만 유효 클러스터로
    const validClusters = comps
      .map((idx) => idx.map((i) => docs[i]))
      .filter((grp) => grp.length >= minGroupSize);

    if (validClusters.length === 0) {
      return {
        ok: true,
        createdClusterCount: 0,
        clipCount: clips.length,
      };
    }

    let createdClusterCount = 0;

    for (const group of validClusters) {
      const sorted = [...group].sort((a, b) => {
        const at = a.publishedAt?.getTime() ?? 0;
        const bt = b.publishedAt?.getTime() ?? 0;
        return at - bt;
      });

      const windowStart = sorted[0].publishedAt ?? null;
      const windowEnd = sorted[sorted.length - 1].publishedAt ?? null;

      const key = clipClusterKey(group);

      // 같은 key 있으면 스킵
      const exist = await prisma.clipClusterSuggestion.findUnique({
        where: { key },
        select: { id: true },
      });
      if (exist) continue;

      const title = group[0].title ?? "유튜브 뉴스 클립 자동 클러스터";
      const summary = `최근 유튜브 뉴스 클립 ${group.length}개를 임베딩 유사도로 묶은 자동 클러스터입니다.`;

      await prisma.clipClusterSuggestion.create({
        data: {
          key,
          title,
          summary,
          confidence: 0.7,
          windowStart,
          windowEnd,
          status: "PENDING",
          items: {
            create: group.map((c) => ({
              youtubeId: c.youtubeId,
              url: c.url,
              title: c.title ?? null,
              channel: c.channel ?? null,
              side: c.side ?? null,
              publishedAt: c.publishedAt ?? undefined,
              summary: c.description ?? undefined,
              rawClip: {
                connect: { id: c.id },
              },
            })),
          },
        },
      });

      createdClusterCount += 1;
    }

    return {
      ok: true,
      createdClusterCount,
      clipCount: clips.length,
    };
  } finally {
    await releaseLock(lock.key, lock.runId);
  }
}

/* ─────────────────────────────────────────────
   유튜브 클립 임베딩 기반 클러스터링 유틸
──────────────────────────────────────────── */

const CLIP_MODEL =
  process.env.CLIP_CLUSTER_EMBED_MODEL?.trim() || "text-embedding-3-small";

const CLIP_BATCH = Math.min(
  Math.max(Number(process.env.CLIP_CLUSTER_BATCH ?? 64), 8),
  256
);

const CLIP_MAX_N = Math.min(
  Number(process.env.CLIP_CLUSTER_MAX_CLIPS ?? 300),
  1000
);

const CLIP_SIM_T = Math.min(
  Math.max(Number(process.env.CLIP_CLUSTER_SIM_THRESHOLD ?? 0.8), 0.5),
  0.99
);

type RawClipLite = {
  id: string;
  youtubeId: string;
  url: string;
  title?: string | null;
  description?: string | null;
  text?: string | null;
  channel?: string | null;
  side?: SourceSide;
  publishedAt?: Date | null;
};

// 제목 + 텍스트(자막/설명)를 하나의 문서로
function clipText(c: RawClipLite): string {
  const title = (c.title ?? "").trim();
  const body = (c.text ?? c.description ?? "").replace(/\s+/g, " ").trim();
  const limited = body.length > 2000 ? body.slice(0, 2000) : body;
  const t = title ? `제목: ${title}\n` : "";
  const b = limited ? `내용: ${limited}` : "";
  const joined = `${t}${b}`.trim();
  return joined.length ? joined : title || "(내용 없음)";
}

// 코사인 유사도
function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

// 연결요소(그래프 컴포넌트)
function connectedComponents(adj: Uint8Array[], n: number): number[][] {
  const visited = new Uint8Array(n);
  const clusters: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const stack = [i];
    visited[i] = 1;
    const comp: number[] = [];
    while (stack.length) {
      const v = stack.pop()!;
      comp.push(v);
      const row = adj[v];
      for (let u = 0; u < n; u++) {
        if (row[u] === 1 && !visited[u]) {
          visited[u] = 1;
          stack.push(u);
        }
      }
    }
    clusters.push(comp);
  }
  return clusters;
}

// OpenAI 임베딩 배치 호출
async function embedClipBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += CLIP_BATCH) {
    const chunk = texts.slice(i, i + CLIP_BATCH);
    const resp = await openai.embeddings.create({
      model: CLIP_MODEL,
      input: chunk,
    });
    for (const d of resp.data) {
      out.push(d.embedding as unknown as number[]);
    }
  }
  return out;
}

// 클러스터 키(유튜브 클립 전용)
function clipClusterKey(clips: RawClipLite[]): string {
  const head = clips
    .slice(0, 3)
    .map((c) => (c.title ?? "").slice(0, 40))
    .join(" | ");
  const h = crypto
    .createHash("sha1")
    .update(clips.map((c) => c.youtubeId).join("|"))
    .digest("hex")
    .slice(0, 10);
  return `${head} :: ${h}`;
}
