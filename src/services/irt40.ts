// src/data/irt40.ts
import { irtQuestions } from "./irtQuestions";
import type { IRTQuestion, IrtAxis } from "./irtQuestions";

/**
 * IRT 40 PRO 구성
 * - Likert 28: 축당 7개 (base+scenario 혼합)
 * - Switch 8: 축당 2개
 * - Forced 4: 축당 1개 (동의편향/극성 보정)
 */

// 1) Likert 28 (축당 7)
export const IRT40_LIKERT_IDS: Record<IrtAxis, string[]> = {
  I: ["i2", "i3", "i4", "i6", "i8", "i11", "i9"],
  C: ["c1", "c2", "c4", "c6", "c8", "c9", "c14"],
  S: ["s2", "s3", "s5", "s6", "s9", "s12", "s7"],
  H: ["h1", "h2", "h4", "h6", "h8", "h9", "h14"],
};

// 2) Switch 8 (축당 2)
export const IRT40_SWITCH_IDS: Record<IrtAxis, string[]> = {
  I: ["t1", "t3"],
  C: ["t4", "t6"],
  S: ["t7", "t9"],
  H: ["t10", "t12"],
};

// 3) Forced 4 (축당 1)
export const IRT40_FORCED_IDS: Record<IrtAxis, string[]> = {
  I: ["fI1"],
  C: ["fC1"],
  S: ["fS1"],
  H: ["fH1"],
};

// 4) 실제 테스트에서 사용할 “문항 순서” (UX 최적)
// - 초반: 이해 쉬운 base
// - 중반: 핵심 변별
// - 후반: scenario
// - 마지막: switch + forced (메타/극성)
export const IRT40_ORDER: string[] = [
  // 빠른 진입 (가벼운 base)
  "i2", "c2", "s3", "h2",
  "i4", "c6", "s6", "h8",

  // 축별 안정화 (base 추가)
  "i3", "c1", "s5", "h1",
  "i6", "c4", "s2", "h4",
  "i8", "c8", "s9", "h6",

  // scenario (개인 + 위험 상황 포함)
  "i11", "c9", "s12", "h9",
  "i9", "c14", "s7", "h14",

  // switch(전환성)
  "t1", "t4", "t7", "t10",
  "t3", "t6", "t9", "t12",

  // forced(극성 보정) - 마지막 4문항
  "fI1", "fC1", "fS1", "fH1",
];

// ---- helpers ----
export function getQuestionsByIds(ids: string[]): IRTQuestion[] {
  const map = new Map(irtQuestions.map((q) => [q.id, q]));
  return ids.map((id) => {
    const q = map.get(id);
    if (!q) throw new Error(`[IRT40] Missing question id: ${id}`);
    return q;
  });
}

export function getIrt40Questions(): IRTQuestion[] {
  return getQuestionsByIds(IRT40_ORDER);
}

// 검사용: 40에 포함된 모든 id set
export const IRT40_ID_SET = new Set(IRT40_ORDER);

// 검사용: 타입별 카운트
export function irt40Counts() {
  const qs = getIrt40Questions();
  return qs.reduce(
    (acc, q) => {
      acc.total += 1;
      const t = q.type ?? "likert";
      acc[t] += 1;
      return acc;
    },
    { total: 0, likert: 0, switch: 0, forced: 0 } as Record<string, number>
  );
}
