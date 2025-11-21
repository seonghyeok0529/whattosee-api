// src/pipelines/news/date.ts (새 파일, 또는 scrapeFeeds.ts 상단에 함께 선언)
export function asDate(v?: string | Date | null): Date {
    if (v instanceof Date) return v;
    const d = new Date(v ?? '');
    return Number.isNaN(d.valueOf()) ? new Date() : d; // 실패 시 지금 시각
  }
  