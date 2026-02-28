import { irtQuestions } from "./irtQuestions.js";
import type { IRTQuestion, IrtAxis } from "./irtQuestions.js";

export const IRT40_LIKERT_IDS: Record<IrtAxis, string[]> = {
  I: ["i2", "i3", "i4", "i6", "i8", "i11", "i9"],
  C: ["c1", "c2", "c4", "c6", "c8", "c9", "c14"],
  S: ["s2", "s3", "s5", "s6", "s9", "s12", "s7"],
  H: ["h1", "h2", "h4", "h6", "h8", "h9", "h14"],
};

export const IRT40_SWITCH_IDS: Record<IrtAxis, string[]> = {
  I: ["t1", "t3"],
  C: ["t4", "t6"],
  S: ["t7", "t9"],
  H: ["t10", "t12"],
};

export const IRT40_FORCED_IDS: Record<IrtAxis, string[]> = {
  I: ["fI1"],
  C: ["fC1"],
  S: ["fS1"],
  H: ["fH1"],
};

export const IRT40_ORDER: string[] = [
  "i2", "c2", "s3", "h2", "i4", "c6", "s6", "h8",
  "i3", "c1", "s5", "h1", "i6", "c4", "s2", "h4", "i8", "c8", "s9", "h6",
  "i11", "c9", "s12", "h9", "i9", "c14", "s7", "h14",
  "t1", "t4", "t7", "t10", "t3", "t6", "t9", "t12",
  "fI1", "fC1", "fS1", "fH1",
];

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

export const IRT40_ID_SET = new Set(IRT40_ORDER);

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
