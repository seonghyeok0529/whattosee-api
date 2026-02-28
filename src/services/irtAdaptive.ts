import { irtQuestions, type IrtAxis } from "./irt/data/irtQuestions.js";

export type IRTAnswers = Record<string, number>;
export type IRTScores = Record<IrtAxis, number>;
export type IRTClarity = Record<IrtAxis, number>;

const AXES: IrtAxis[] = ["I", "C", "S", "H"];

export const IRT_SEED_IDS: string[] = [
  "i2", "i3", "i6",
  "c2", "c3", "c6",
  "s2", "s3", "s6",
  "h2", "h3", "h6",
];

const POOL_BY_AXIS: Record<IrtAxis, string[]> = {
  I: ["i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i10", "i11", "i12", "i13", "i14", "i9", "i15"],
  C: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c10", "c9", "c11", "c12", "c13", "c14", "c15"],
  S: ["s1", "s2", "s3", "s4", "s5", "s6", "s8", "s9", "s10", "s12", "s13", "s11", "s14", "s7", "s15"],
  H: ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h10", "h11", "h12", "h9", "h13", "h14", "h15"],
};

function norm7(v: number) {
  return (v - 1) / 6;
}

export function computeScoresFromAnswered(answers: IRTAnswers): IRTScores {
  const agg: Record<IrtAxis, { sum: number; cnt: number }> = {
    I: { sum: 0, cnt: 0 },
    C: { sum: 0, cnt: 0 },
    S: { sum: 0, cnt: 0 },
    H: { sum: 0, cnt: 0 },
  };

  for (const q of irtQuestions) {
    const v = answers[q.id];
    if (!v) continue;
    const n = norm7(v);
    const dirApplied = q.dir === 1 ? n : 1 - n;
    agg[q.axis].sum += dirApplied;
    agg[q.axis].cnt += 1;
  }

  const out: IRTScores = { I: 50, C: 50, S: 50, H: 50 };
  for (const ax of AXES) {
    const { sum, cnt } = agg[ax];
    out[ax] = cnt ? Math.round((sum / cnt) * 100) : 50;
  }
  return out;
}

export function computeClarity(scores: IRTScores): IRTClarity {
  return {
    I: Math.round(Math.abs(scores.I - 50) * 2),
    C: Math.round(Math.abs(scores.C - 50) * 2),
    S: Math.round(Math.abs(scores.S - 50) * 2),
    H: Math.round(Math.abs(scores.H - 50) * 2),
  };
}

function countAnsweredByAxis(answers: IRTAnswers): Record<IrtAxis, number> {
  const c: Record<IrtAxis, number> = { I: 0, C: 0, S: 0, H: 0 };
  for (const q of irtQuestions) {
    if (answers[q.id]) c[q.axis] += 1;
  }
  return c;
}

function pickNextId(axis: IrtAxis, used: Set<string>) {
  const pool = POOL_BY_AXIS[axis];
  return pool.find((id) => !used.has(id)) ?? null;
}

export function expandQuestionOrder(params: {
  currentOrder: string[];
  answers: IRTAnswers;
  clarityThreshold: number;
  minPerAxis: number;
  maxTotal: number;
}) {
  const { currentOrder, answers, clarityThreshold, minPerAxis, maxTotal } = params;
  const used = new Set(currentOrder);

  const scores = computeScoresFromAnswered(answers);
  const clarity = computeClarity(scores);
  const answeredCount = countAnsweredByAxis(answers);

  const order = [...currentOrder];

  const needsMore = (ax: IrtAxis) => answeredCount[ax] < minPerAxis || clarity[ax] < clarityThreshold;

  while (order.length < maxTotal) {
    const neededAxes = AXES.filter(needsMore);
    if (neededAxes.length === 0) break;

    neededAxes.sort((a, b) => clarity[a] - clarity[b]);

    let appended = false;
    for (const ax of neededAxes) {
      const nextId = pickNextId(ax, used);
      if (!nextId) continue;
      order.push(nextId);
      used.add(nextId);
      appended = true;
      break;
    }

    if (!appended) break;
    break;
  }

  return { order, scores, clarity };
}

export function canFinishEarly(params: {
  answers: IRTAnswers;
  clarityThreshold: number;
  minPerAxis: number;
}) {
  const { answers, clarityThreshold, minPerAxis } = params;
  const scores = computeScoresFromAnswered(answers);
  const clarity = computeClarity(scores);
  const cnt = countAnsweredByAxis(answers);

  const ok = AXES.every((ax) => cnt[ax] >= minPerAxis && clarity[ax] >= clarityThreshold);
  return { ok, scores, clarity, cnt };
}
