// src/pipelines/news/utils/normalizeUrl.ts

/** URL 정규화(중복 제거 키용): 해시/쿼리 잡음 제거 */
export function normalizeUrl(u: string): string {
  const raw = (u ?? "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
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

    // ✅ trailing slash 통일(선택): 너무 공격적이면 빼도 됨
    // if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    //   url.pathname = url.pathname.slice(0, -1);
    // }

    return url.toString();
  } catch {
    // URL 파싱 실패 시, 최소 트리밍
    return raw.split("#")[0];
  }
}
