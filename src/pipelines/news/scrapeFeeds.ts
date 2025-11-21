import Parser from "rss-parser";
import type { RawArticleLite, SourceSide } from "./types.js";
import fs from "fs";

/** 환경에서 읽는 피드 설정 */
type FeedConf = { outlet: string; url: string; side?: SourceSide };

const parser = new Parser({
  timeout: Number(process.env.NEWS_TIMEOUT_MS ?? 12000),
});

/** env JSON 파싱 + 검증 (파일 우선) */
function loadFeeds(): FeedConf[] {
  const path = process.env.NEWS_FEEDS_FILE?.trim();
  let raw = "";
  if (path && fs.existsSync(path)) {
    raw = fs.readFileSync(path, "utf8");
  } else {
    raw = (process.env.NEWS_FEEDS ?? "").trim();
  }

  if (!raw) return [];

  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({
        outlet: String(x.outlet ?? ""),
        url: String(x.url ?? ""),
        side: (["left", "center", "right", "neutral"] as const).includes(x.side)
          ? (x.side as SourceSide)
          : "center",
      }))
      .filter((x) => x.outlet && /^https?:\/\//i.test(x.url));
  } catch (e) {
    console.warn("[loadFeeds] JSON parse error:", e);
    return [];
  }
}

/** 안전한 날짜 변환 */
function toDate(d?: string | number | Date | null): Date {
  if (!d) return new Date();
  const dt = new Date(d);
  return isNaN(+dt) ? new Date() : dt;
}

/** URL 정규화(중복 제거 키용): 해시/쿼리 잡음 제거 */
function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";

    // 추적 파라미터 제거
    const params = url.searchParams;
    const removePrefixes = ["utm_", "spm", "fbclid", "gclid", "igshid", "ref", "sr_share"];
    const removeExact = new Set([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "fbclid",
      "gclid",
      "igshid",
      "ref",
      "sr_share",
    ]);

    Array.from(params.keys()).forEach((k) => {
      const key = k.toLowerCase();
      if (removeExact.has(key) || removePrefixes.some((p) => key.startsWith(p))) {
        params.delete(k);
      }
    });

    // 내용과 무관한 표시용 파라미터 제거
    const ignoreParams = ["outputtype", "type", "sns"];
    ignoreParams.forEach((k) => params.delete(k));

    url.search = params.toString();
    return url.toString();
  } catch {
    // URL 파싱 실패 시, 최소 트리밍
    return u.split("#")[0];
  }
}

/**
 * 라운드로빈으로 공정 수집:
 * - 각 피드에서 최신 순으로 최대 perFeed개까지 준비
 * - 모든 피드를 interleave(1개씩 번갈아) 하면서 cap까지 채움
 * - URL 정규화 기반 dedup으로 편향/중복 최소화
 */
export async function scrapeFeeds(): Promise<RawArticleLite[]> {
  const feeds = loadFeeds();

  // 기본 50개/피드, 전체 cap은 설정 없으면 (피드 수 * perFeed)로
  const perFeed = Math.min(Number(process.env.NEWS_MAX_PER_FEED ?? 50), 200);
  const configuredCap = Number(process.env.NEWS_MAX_ARTICLES ?? 0);
  const cap =
    configuredCap > 0
      ? Math.min(configuredCap, feeds.length * perFeed)
      : Math.min(feeds.length * perFeed, 1000);

  const cooldown = Number(process.env.NEWS_COOLDOWN_MS ?? 300);

  // 피드별 아이템(최신순) 준비
  const perFeedBuckets: RawArticleLite[][] = [];

  for (const f of feeds) {
    try {
      const feed = await parser.parseURL(f.url);

      // 최신순 정렬 → 상단부터 perFeed만 취함
      const items = (feed.items ?? [])
        .map((it) => {
          const link = (it.link || it.guid || "").trim();
          const title = String(it.title ?? "").trim();
          const publishedAt = toDate((it as any).isoDate ?? (it as any).pubDate ?? new Date());

          const a: RawArticleLite = {
            url: link,
            title: title || "(제목 없음)",
            outlet: f.outlet,
            side: (f.side ?? "center") as SourceSide,
            publishedAt, // 항상 Date
          };
          return a;
        })
        .filter((a) => /^https?:\/\//i.test(a.url))
        .sort((a, b) => (b.publishedAt!.getTime()) - (a.publishedAt!.getTime()))
        .slice(0, perFeed);

      perFeedBuckets.push(items);

      if (cooldown > 0) {
        await new Promise((r) => setTimeout(r, cooldown));
      }
    } catch (e) {
      console.warn("[scrapeFeeds] fail:", f.url, e);
      perFeedBuckets.push([]); // 자리 유지
    }
  }

  // 라운드로빈 interleave
  const interleaved: RawArticleLite[] = [];
  let added = 0;
  let round = 0;

  // URL 정규화 기반 dedup
  const seen = new Set<string>();

  // 버킷 길이 중 최대치만큼 라운드 진행
  const maxLen = Math.max(...perFeedBuckets.map((b) => b.length), 0);

  while (round < maxLen && added < cap) {
    for (let i = 0; i < perFeedBuckets.length; i++) {
      if (added >= cap) break;
      const bucket = perFeedBuckets[i];
      const item = bucket[round];
      if (!item) continue;

      const key = normalizeUrl(item.url);
      if (seen.has(key)) continue;

      seen.add(key);
      interleaved.push({ ...item, url: key }); // 정규화 URL 반영
      added++;
    }
    round++;
  }

  return interleaved;
}
