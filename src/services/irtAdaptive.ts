// src/services/irtAdaptive.ts 
import { irtQuestions, type IrtAxis, type IRTQuestion } from "../data/irtQuestions"; 

export type IRTAnswers = Record<string, number>;
export type IRTScores = Record<IrtAxis, number>;
export type IRTClarity = Record<IrtAxis, number>; // 0~100 

const AXES: IrtAxis[] = ["I", "C", "S", "H"];

// ✅ 1단계 Seed(12문항): 축당 3개 (base 위주로 고정)
// 필요하면 여기만 튜닝하면 됨.
export const IRT_SEED_IDS: string[] = [
  // I
  "i2", "i3", "i6",
  // C
  "c2", "c3", "c6",
  // S
  "s2", "s3", "s6",
  // H
  "h2", "h3", "h6",
];

// 각 축별 풀(pool) 순서: base 먼저 -> scenario 나중
const POOL_BY_AXIS: Record<IrtAxis, string[]> = {
  I: ["i1","i2","i3","i4","i5","i6","i7","i8","i10","i11","i12","i13","i14","i9","i15"],
  C: ["c1","c2","c3","c4","c5","c6","c7","c8","c10","c9","c11","c12","c13","c14","c15"],
  S: ["s1","s2","s3","s4","s5","s6","s8","s9","s10","s12","s13","s11","s14","s7","s15"],
  H: ["h1","h2","h3","h4","h5","h6","h7","h8","h10","h11","h12","h9","h13","h14","h15"],
};

function norm7(v: number) {
  return (v - 1) / 6; // 1→0, 7→1
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
  // |score-50|이 클수록 확신도 높음
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

/**
 * ✅ Adaptive 확장
 * - 최소 질문 수(minPerAxis)까지는 강제로 채움
 * - clarity가 threshold 미만인 축은 계속 추가(최대 maxTotal)
 */
export function expandQuestionOrder(params: {
  currentOrder: string[];
  answers: IRTAnswers;
  clarityThreshold: number; // 0~100
  minPerAxis: number;       // 권장 6 (총 24)
  maxTotal: number;         // 60
}) {
  const { currentOrder, answers, clarityThreshold, minPerAxis, maxTotal } = params;
  const used = new Set(currentOrder);

  const scores = computeScoresFromAnswered(answers);
  const clarity = computeClarity(scores);
  const answeredCount = countAnsweredByAxis(answers);

  const order = [...currentOrder];

  const needsMore = (ax: IrtAxis) =>
    answeredCount[ax] < minPerAxis || clarity[ax] < clarityThreshold;

  // 라운드 로빈으로 필요한 축을 채움
  while (order.length < maxTotal) {
    const neededAxes = AXES.filter(needsMore);
    if (neededAxes.length === 0) break;

    // 가장 불확실(clarity 낮은) 축부터 우선
    neededAxes.sort((a, b) => clarity[a] - clarity[b]);

    let appended = false;

    for (const ax of neededAxes) {
      const nextId = pickNextId(ax, used);
      if (!nextId) continue;

      order.push(nextId);
      used.add(nextId);
      appended = true;

      // 1개 추가하면 루프 밖으로 나가서, 다음 답변 이후 다시 평가(너무 길어지는 것 방지)
      break;
    }

    if (!appended) break;
    // 한 번에 여러 개 붙이지 않음(사용자 경험/성능 위해)
    break;
  }

  return { order, scores, clarity };
}

/**
 * 유저가 "지금 여기까지 결과 보기"를 눌렀을 때,
 * 최소 기준을 통과했는지 체크용.
 */
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
