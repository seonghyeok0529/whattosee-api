export function normalizeTitle(t?: string): string {
    const s = (t ?? "")
      .replace(/［.*?］|\[.*?\]|\(.*?\)|\{.*?\}/g, " ") // 괄호 문구 제거
      .replace(/(?:단독|속보|영상|기사|포토)\s*:\s*/gi, " ")
      .replace(/[“”"':\-–—·•|/\\.,!?;~%^&*+=<>{}\[\]()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return s.toLowerCase();
  }
  