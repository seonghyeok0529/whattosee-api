// src/utils/dayKey.ts
export function dayKeyKST(d = new Date()) {
    // UTC+9 보정
    const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return kst.toISOString().slice(0, 10); // YYYY-MM-DD
  }
  