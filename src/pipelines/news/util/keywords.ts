// src/pipelines/news/util/keywords.ts
export function normalizeTitle(raw?: string): string {
    const s = (raw ?? "")
      .replace(/\[[^\]]*?\]|\([^\)]*?\)|\{[^}]*?\}/g, " ") // 괄호 블록 제거
      .replace(/(\s|-|·|—|:)+$/g, "")                     // 끝말줄임/구두점 꼬리 제거
      .replace(/\s+/g, " ")
      .trim();
    return s || "(제목 없음)";
  }
  
  /** 간단 키워드 추출 (제목/요약/본문에서 2자 이상, 불용어 제거) */
  export function extractKeywords(input: string, topK = 12): string[] {
    const STOP = new Set([
      "the","a","an","and","or","but","of","to","in","on","for","with","by","at","from","as","is","are","was","were",
      "및","과","또는","등","대한","에서","으로","에게","에서의","에","를","은","는","이","가","도","만","까지","부터",
    ]);
    const text = (input ?? "")
      .toLowerCase()
      .replace(/[“”"':\-–—·•|/\\.,!?;~%^&*+=<>{}\[\]()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  
    const freq = new Map<string, number>();
    for (const w of text.split(" ")) {
      if (!w || w.length < 2 || STOP.has(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    return Array.from(freq.entries())
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, topK)
      .map(([w]) => w);
  }
  