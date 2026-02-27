// src/lib/irtScoring.ts
import { irtQuestions, type IrtAxis, type IrtScenario, type IRTQuestion } from "../data/irtQuestions";

export type AnswerValue = number | "A" | "B";
export type IRTAnswers = Record<string, AnswerValue>;


export function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

// 내부 공통 집계: 1~7 → 0~1 정규화 + dir 적용 → 0~100
function scoreByFilter(answers: IRTAnswers, filter: (q: IRTQuestion) => boolean): IRTScores {
  const axes: IrtAxis[] = ["I", "C", "S", "H"];
  const agg: Record<IrtAxis, { sum: number; cnt: number }> = {
    I: { sum: 0, cnt: 0 },
    C: { sum: 0, cnt: 0 },
    S: { sum: 0, cnt: 0 },
    H: { sum: 0, cnt: 0 },
  };

  for (const q of irtQuestions) {
    if (!filter(q)) continue;

    const v = answers[q.id];
    if (typeof v !== "number") continue;

    const norm = (v - 1) / 6; // 1→0, 7→1
    const dirApplied = q.dir === 1 ? norm : 1 - norm; // dir=-1이면 반전

    agg[q.axis].sum += dirApplied;
    agg[q.axis].cnt += 1;
  }

  const out: IRTScores = { I: 50, C: 50, S: 50, H: 50 };
  for (const ax of axes) {
    const { sum, cnt } = agg[ax];
    out[ax] = cnt ? Math.round((sum / cnt) * 100) : 50;
  }
  return out;
}

/**
 * ✅ Base(성향) 점수: layer="base" 40문항
 */
export function computeBaseScores(answers: IRTAnswers): IRTScores {
  return scoreByFilter(answers, (q) => q.layer === "base");
}

/**
 * ✅ Scenario(상황) 점수: layer="scenario" 중 특정 scenario만
 */
export function computeScenarioScores(answers: IRTAnswers, scenario: IrtScenario): IRTScores {
  return scoreByFilter(answers, (q) => q.layer === "scenario" && q.scenario === scenario);
}

/**
 * ✅ 기존 호환: computeIrtScores는 "기본 성향 점수"로 정의
 * (기존 Result/Test가 이 함수를 쓰면 자동으로 Base 기반 타입이 안정적으로 나옴)
 */
export function computeIrtScores(answers: IRTAnswers): IRTScores {
  return computeBaseScores(answers);
}

/**
 * 4축 → 16유형 코드 (Base 점수 기준)
 */
export function deriveIrtType(scores: IRTScores) {
  const inflow = scores.I >= 50 ? "MA" : "MI"; // Macro vs Micro
  const cause = scores.C >= 50 ? "SY" : "PE";  // System vs Person
  const standard = scores.S >= 50 ? "CO" : "RU"; // Context vs Rule
  const interp = scores.H >= 50 ? "ME" : "FA"; // Meaning vs Fault
  return `${inflow}-${cause}-${standard}-${interp}` as const;
}

/**
 * 축별 내러티브(편차 큰 순) — Base 점수용
 */
export function makeIrtNarrative(scores: IRTScores) {
  const axesOrder = (Object.entries(scores) as [IrtAxis, number][])
    .sort((a, b) => Math.abs(b[1] - 50) - Math.abs(a[1] - 50));

  return axesOrder.map(([ax, v]) => {
    const tilt = v - 50;
    if (ax === "I") {
      return tilt >= 0
        ? `이슈를 접하면 <b>거시 흐름·데이터·전체 맥락</b>에서 출발하는 경향이 강합니다.`
        : `이슈를 접하면 <b>개별 사건·인물·현장 디테일</b>에서 출발하는 경향이 강합니다.`;
    }
    if (ax === "C") {
      return tilt >= 0
        ? `원인을 찾을 때 <b>제도·환경·유인 구조</b>를 우선적으로 살피는 편입니다.`
        : `원인을 찾을 때 <b>개인의 선택·의지·책임</b>을 우선적으로 보는 편입니다.`;
    }
    if (ax === "S") {
      return tilt >= 0
        ? `판단 기준에서 <b>맥락·사정·예외</b>를 중요하게 고려하는 편입니다.`
        : `판단 기준에서 <b>원칙·규칙·동일 적용</b>을 우선하는 편입니다.`;
    }
    // H
    return tilt >= 0
      ? `해석에서 <b>미래 신호·변화·교훈</b>을 뽑아내는 데 관심이 큽니다.`
      : `해석에서 <b>책임 규명·과오·단죄</b>가 먼저 중요하다고 느끼는 편입니다.`;
  });
}

/**
 * 타입 카피 (원하면 16개 전부 채우면 됨)
 */
export function irtTypeCopy(type: string) {
  const dict: Record<string, string> = {
    "MI-PE-RU-FA": "개별·개인·원칙·책임형",
    "MA-SY-CO-ME": "거시·구조·맥락·신호형",
  };
  return dict[type] ?? "혼합형(상황 기반)";
}

/**
 * ✅ 케바케 지표: CVI(Context Variability Index)
 * - scenario(personal/public/risk) 별 점수를 구해
 * - 축별 표준편차(0~100 스케일)를 계산
 */
export function computeCVI(answers: IRTAnswers) {
  const scenarios: IrtScenario[] = ["personal", "public", "risk"];
  const scenarioScores = {
    personal: computeScenarioScores(answers, "personal"),
    public: computeScenarioScores(answers, "public"),
    risk: computeScenarioScores(answers, "risk"),
  } as const;

  const std = (vals: number[]) => {
    const n = vals.length;
    if (!n) return 0;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const v = vals.reduce((acc, x) => acc + (x - mean) ** 2, 0) / n; // population std
    return Math.sqrt(v);
  };

  const axes: IrtAxis[] = ["I", "C", "S", "H"];
  const byAxis: Record<IrtAxis, number> = { I: 0, C: 0, S: 0, H: 0 };

  for (const ax of axes) {
    const vals = scenarios.map((s) => scenarioScores[s][ax]);
    byAxis[ax] = Number(std(vals).toFixed(2));
  }

  const total = Number((axes.reduce((acc, ax) => acc + byAxis[ax], 0) / axes.length).toFixed(2));

  const level =
    total <= 6 ? "LOW" :
    total <= 12 ? "MEDIUM" :
    "HIGH";

  return { total, level, byAxis, scenarioScores };
}

/**
 * 백엔드 제출용: answers Record → number[60] (문항 순서 고정)
 */
export function toIrtAnswerArray(answers: IRTAnswers) {
  return irtQuestions.map((q) => answers[q.id]);
}

/**
 * 기존 일관성 체크 (pairs는 기존 id 유지로 그대로 동작)
 */
export function computeIrtConsistency(answers: IRTAnswers) {
  const pairs: Array<{ a: string; b: string; opposite: boolean }> = [
    // 유입
    { a: "i1", b: "i15", opposite: true },
    { a: "i3", b: "i12", opposite: true },

    // 원인
    { a: "c1", b: "c7", opposite: true },
    { a: "c8", b: "c10", opposite: true },

    // 기준
    { a: "s1", b: "s8", opposite: true },
    { a: "s11", b: "s12", opposite: true },

    // 해석
    { a: "h1", b: "h8", opposite: true },
    { a: "h7", b: "h12", opposite: true },

    // 같은 방향 중복 체크
    { a: "i2", b: "i8", opposite: false },
    { a: "h6", b: "h15", opposite: false },
  ];

  const diffs: number[] = [];
  for (const p of pairs) {
    const A = answers[p.a];
    const B = answers[p.b];
    if (typeof A !== "number" || typeof B !== "number") continue;
    const alignedB = p.opposite ? 8 - B : B;
    diffs.push(Math.abs(A - alignedB));
  }

  const avg = diffs.length ? diffs.reduce((s, x) => s + x, 0) / diffs.length : null;

  const level =
    avg === null ? "UNKNOWN"
    : avg <= 1.2 ? "HIGH"
    : avg <= 1.8 ? "MEDIUM"
    : "LOW";

  return { pairAvgDiff: avg, level, pairsUsed: diffs.length };
}

/**
 * 공유용
 */
export function encodeAnswersToParam(answers: IRTAnswers) {
  return btoa(JSON.stringify(answers));
}
export function decodeAnswersParam(param: string | null): IRTAnswers | null {
  if (!param) return null;
  try {
    const json = atob(param);
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? (obj as IRTAnswers) : null;
  } catch {
    return null;
  }
}
