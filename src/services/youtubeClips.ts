// src/services/youtubeClips.ts
import axios from "axios";
import prisma from "@/lib/prisma";
import { ArticleStatus, SourceSide } from "@prisma/client";
import OpenAI from "openai";
import crypto from "crypto";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  

// ─────────────────────────────────────────────
// 환경 변수에서 채널 리스트 파싱
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// 유튜브 API 호출: 채널별 최근 N시간 영상 가져오기
// ─────────────────────────────────────────────

type FetchChannelClipsOptions = {
  channelId: string;
  hours?: number;
};

async function fetchChannelClips({ channelId, hours = 24 }: FetchChannelClipsOptions) {
    if (!YT_API_KEY) {
      throw new Error("YOUTUBE_API_KEY가 설정되어 있지 않습니다.");
    }
  
    const now = new Date();
    const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
  
    const params = {
      key: YT_API_KEY,
      part: "snippet",
      channelId,
      order: "date",
      publishedAfter: from.toISOString(),
      maxResults: 50,
      type: "video",
    };
  
    const url = "https://www.googleapis.com/youtube/v3/search";
  
    try {
      console.log("[YT DEBUG] request", { url, params });
  
      const { data } = await axios.get(url, { params });
  
      console.log("[YT DEBUG] response ok, item count =", (data as any)?.items?.length ?? 0);
  
      const items: any[] = (data as any)?.items ?? [];
  
      return items
        .map((item) => {
          const videoId = item.id?.videoId as string | undefined;
          const snippet = item.snippet ?? {};
  
          return {
            youtubeId: videoId,
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
        .filter((clip) => !!clip.youtubeId);
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
  

// ─────────────────────────────────────────────
// 1) 유튜브 뉴스 클립 수집 → RawClip 저장
// ─────────────────────────────────────────────

export async function ingestYoutubeNewsClips(options?: { hours?: number }) {
  const hours = options?.hours ?? 24;

  if (!YT_API_KEY) {
    throw new Error("YOUTUBE_API_KEY가 설정되어 있지 않습니다.");
  }

  const allChannels = [
    ...PUBLIC_CHANNELS,
    ...LEFT_CHANNELS,
    ...RIGHT_CHANNELS,
  ];

  if (allChannels.length === 0) {
    throw new Error(
      "수집할 유튜브 채널이 없습니다. .env의 YOUTUBE_*_CHANNELS 값을 확인해주세요."
    );
  }

  let fetchedCount = 0;
  let createdCount = 0;
  let skippedCount = 0;
  const errors: { channelId: string; error: string }[] = [];

  for (const channelId of allChannels) {
    try {
      const clips = await fetchChannelClips({ channelId, hours });
      fetchedCount += clips.length;

      const side = resolveSide(channelId);

      for (const clip of clips) {
        
        if (!clip.youtubeId) continue;
        
        const thumbnail = clip.thumbnail ?? null;

        // 이미 있는지 확인
        const exists = await prisma.rawClip.findUnique({
          where: { youtubeId: clip.youtubeId },
        });

        if (exists) {
          skippedCount += 1;
          continue;
        }

        await prisma.rawClip.create({
          data: {
            youtubeId: clip.youtubeId,
            title: clip.title ?? "(제목 없음)",
            description: clip.description,
            channel: (clip.channelTitle ?? channelId).trim(),
            side,
            url: `https://www.youtube.com/watch?v=${clip.youtubeId}`,
            thumbnail: thumbnail,
            publishedAt: clip.publishedAt,
            status: "FETCHED",
          },
        });

        createdCount += 1;
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

  // 디버그 로그
  console.log(
    `[ingestYoutubeNewsClips] hours=${hours}, channels=${allChannels.length}, fetched=${fetchedCount}, created=${createdCount}, skipped=${skippedCount}, errors=${errors.length}`
  );

  return {
    hours,
    channelCount: allChannels.length,
    fetchedCount,
    createdCount,
    skippedCount,
    errors,
  };
}

// ─────────────────────────────────────────────
// 2) RawClip → ClipClusterSuggestion (임베딩 기반)
// ─────────────────────────────────────────────

export async function clusterYoutubeNewsClips(options?: {
    minGroupSize?: number;
  }) {
    const minGroupSize = options?.minGroupSize ?? 2;
  
    // 1) 클러스터링 대상 클립 가져오기
    const clips = await prisma.rawClip.findMany({
      where: {
        status: {
          in: [ArticleStatus.FETCHED, ArticleStatus.PARSED],
        },
        // 필요하면 여기서 publishedAt 기준 기간 필터도 추가 가능
        // publishedAt: { gte: someDate }
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
  
    // 2) 텍스트 → 임베딩
    const texts = docs.map(clipText);
    const embs = await embedClipBatch(texts);
    const n = embs.length;
  
    // 3) 유사도 행렬(그래프) 생성
    const adj: Uint8Array[] = Array.from(
      { length: n },
      () => new Uint8Array(n)
    );
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
  
      // 혹시 같은 key 클러스터가 이미 있으면 스킵 (중복 생성 방지)
      const exist = await prisma.clipClusterSuggestion.findUnique({
        where: { key },
        select: { id: true },
      });
      if (exist) continue;
  
      // 대표 제목: 가장 많이 등장하는 키워드까지 갈 수 있지만,
      // 일단은 첫 번째 클립 제목 활용
      const title =
        group[0].title ??
        "유튜브 뉴스 클립 자동 클러스터";
  
      const summary = `최근 유튜브 뉴스 클립 ${group.length}개를 임베딩 유사도로 묶은 자동 클러스터입니다.`;
  
      await prisma.clipClusterSuggestion.create({
        data: {
          key,
          title,
          summary,
          confidence: 0.7, // 나중에 평균 유사도로 계산해도 됨
          windowStart,
          windowEnd,
          status: "PENDING",
          items: {
            create: group.map((c) => ({
              youtubeId: c.youtubeId,
              url: c.url,
              title: c.title,
              channel: c.channel,
              side: c.side,
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
  }
  
// ─────────────────────────────────────────────
// 유튜브 클립 임베딩 기반 클러스터링 유틸
// ─────────────────────────────────────────────

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
// 기본 유사도 임계값(기사보다 살짝 낮게 잡고 시작해도 됨)
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
  const body =
    (c.text ?? c.description ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const limited = body.length > 2000 ? body.slice(0, 2000) : body;
  const t = title ? `제목: ${title}\n` : "";
  const b = limited ? `내용: ${limited}` : "";
  const joined = `${t}${b}`.trim();
  return joined.length ? joined : (title || "(내용 없음)");
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
