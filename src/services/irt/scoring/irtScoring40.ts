import type { IrtAxis } from "../data/irtQuestions.js";
import type { AnswerValue, IRTAnswers, IRTScores } from "./irtScoring.js";
import { clamp } from "./irtScoring.js";
import { irtQuestions } from "../data/irtQuestions.js";
import { IRT40_LIKERT_IDS, IRT40_SWITCH_IDS, IRT40_FORCED_IDS } from "../data/irt40.js";

const AXES: IrtAxis[] = ["I", "C", "S", "H"];

function norm01(v: number) {
  return (v - 1) / 6;
}

function isNum(v: AnswerValue | undefined): v is number {
  return typeof v === "number";
}

function isAB(v: AnswerValue | undefined): v is "A" | "B" {
  return v === "A" || v === "B";
}

export const FORCED_WEIGHT_POINTS = 4;
export const RISK_SCENARIO_WEIGHT = 1.2;

export function computeIrt40Scores(answers: IRTAnswers): IRTScores {
  const out: IRTScores = { I: 50, C: 50, S: 50, H: 50 };

  for (const ax of AXES) {
    const ids = IRT40_LIKERT_IDS[ax];
    let weightedSum = 0;
    let totalWeight = 0;

    for (const id of ids) {
      const q = irtQuestions.find((x) => x.id === id);
      if (!q || (q.type ?? "likert") !== "likert") continue;

      const v = answers[id];
      if (!isNum(v)) continue;

      const x = norm01(v);
      const signed = q.dir === 1 ? x : 1 - x;
      const weight = q.scenario === "risk" ? RISK_SCENARIO_WEIGHT : 1;
      weightedSum += signed * weight;
      totalWeight += weight;
    }

    if (totalWeight > 0) {
      out[ax] = clamp((weightedSum / totalWeight) * 100, 0, 100);
    }
  }

  const forcedAdj = computeIrt40ForcedAdjustment(answers);
  for (const ax of AXES) {
    out[ax] = clamp(out[ax] + forcedAdj[ax], 0, 100);
  }

  return out;
}

export function computeIrt40ForcedAdjustment(answers: IRTAnswers): Record<IrtAxis, number> {
  const adj: Record<IrtAxis, number> = { I: 0, C: 0, S: 0, H: 0 };

  for (const ax of AXES) {
    const [id] = IRT40_FORCED_IDS[ax];
    const q = irtQuestions.find((x) => x.id === id);
    const v = answers[id];
    if (!q || (q.type ?? "likert") !== "forced" || !isAB(v)) continue;

    const picked = q.options?.find((o) => o.key === v);
    if (!picked) continue;

    adj[ax] = picked.pole === "right" ? +FORCED_WEIGHT_POINTS : -FORCED_WEIGHT_POINTS;
  }

  return adj;
}

export function computeIrt40Switchiness(answers: IRTAnswers) {
  const valsAll: number[] = [];
  const byAxis: Partial<Record<IrtAxis, number>> = {};

  for (const ax of AXES) {
    const ids = IRT40_SWITCH_IDS[ax];
    const vals: number[] = [];

    for (const id of ids) {
      const v = answers[id];
      if (isNum(v)) vals.push(v);
    }

    if (vals.length) {
      byAxis[ax] = vals.reduce((a, b) => a + b, 0) / vals.length;
      valsAll.push(...vals);
    }
  }

  const avg = valsAll.length ? valsAll.reduce((a, b) => a + b, 0) / valsAll.length : null;
  const level = avg == null ? "UNKNOWN" : avg >= 5.0 ? "HIGH" : avg >= 3.8 ? "MEDIUM" : "LOW";

  return { avg, byAxis, level, answered: valsAll.length, total: 8 };
}

export function deriveIrtType40(scores: IRTScores) {
  const I = scores.I >= 50 ? "MA" : "MI";
  const C = scores.C >= 50 ? "SY" : "PE";
  const S = scores.S >= 50 ? "CO" : "RU";
  const H = scores.H >= 50 ? "ME" : "FA";
  return `${I}-${C}-${S}-${H}`;
}

export function poleForAxis(axis: IrtAxis, v: number) {
  if (axis === "I") return v >= 50 ? "Macro" : "Micro";
  if (axis === "C") return v >= 50 ? "System" : "Person";
  if (axis === "S") return v >= 50 ? "Context" : "Rule";
  return v >= 50 ? "Meaning" : "Fault";
}

export function axisName(axis: IrtAxis) {
  if (axis === "I") return "유입";
  if (axis === "C") return "원인";
  if (axis === "S") return "기준";
  return "해석";
}

export function axisTagline(axis: IrtAxis, pole: string) {
  if (axis === "I") return pole === "Macro" ? "큰 흐름·데이터에서 출발" : "현장·사람 디테일에서 출발";
  if (axis === "C") return pole === "System" ? "구조·유인에서 원인 탐색" : "선택·책임에서 원인 탐색";
  if (axis === "S") return pole === "Context" ? "맥락·사정을 기준에 포함" : "원칙·동일 적용을 우선";
  return pole === "Meaning" ? "미래 신호·교훈 중심" : "위협 차단·책임 경계선 설정";
}

export function responsePatternLabel40(level: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN") {
  if (level === "HIGH") return { title: "상황 전환형", sub: "이슈 종류에 따라 모드 전환이 큼" };
  if (level === "MEDIUM") return { title: "상황 민감형", sub: "상황에 따라 일부 축이 흔들림" };
  if (level === "LOW") return { title: "안정형", sub: "상황이 달라도 비교적 일관" };
  return { title: "분석 중", sub: "전환성 문항 응답이 부족" };
}
