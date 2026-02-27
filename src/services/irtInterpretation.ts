// src/services/irtInterpretation.ts
type Scores = { I: number; C: number; S: number; H: number };

export type CVILevel = "LOW" | "MEDIUM" | "HIGH";

function pole(axis: keyof Scores, v: number) {
  if (axis === "I") return v >= 50 ? "Macro" : "Micro";
  if (axis === "C") return v >= 50 ? "System" : "Person";
  if (axis === "S") return v >= 50 ? "Context" : "Rule";
  return v >= 50 ? "Meaning" : "Fault";
}

function axisDetail(axis: keyof Scores, v: number) {
  const p = pole(axis, v);

  if (axis === "I" && p === "Macro") return {
    title: "유입: Macro",
    body: [
      "이슈를 ‘사례’보다 ‘흐름/패턴’으로 먼저 잡습니다.",
      "강점: 감정적 디테일에 덜 흔들리고, 구조적 설명을 선호합니다.",
      "주의: 현장감/당사자 경험이 뒤로 밀리면 차갑게 보일 수 있습니다.",
      "균형 질문: ‘이 이슈의 한 사람에게는 어떤 장면으로 체감될까?’",
    ],
  };
  if (axis === "I" && p === "Micro") return {
    title: "유입: Micro",
    body: [
      "이슈를 구체적 장면/인물/상황에서 출발합니다.",
      "강점: 현장감과 동기를 놓치지 않습니다.",
      "주의: 사례 하나가 전체를 대표하는 듯 느껴져 일반화 위험이 있습니다.",
      "균형 질문: ‘이게 반복되는 패턴인지, 예외인지 데이터가 있나?’",
    ],
  };

  if (axis === "C" && p === "System") return {
    title: "원인: System",
    body: [
      "원인을 개인보다 제도/환경/유인 구조에서 찾습니다.",
      "강점: 재발 방지(구조 개선) 관점이 강합니다.",
      "주의: 개인 책임이 약해 보이면 ‘책임 회피’로 오해될 수 있습니다.",
      "균형 질문: ‘같은 구조에서도 선택이 달랐던 사람은 왜 달랐지?’",
    ],
  };
  if (axis === "C" && p === "Person") return {
    title: "원인: Person",
    body: [
      "원인을 선택/의지/책임에서 먼저 봅니다.",
      "강점: 책임 소재를 빠르게 정리해 규범 회복에 유리합니다.",
      "주의: 시스템 요인을 놓치면 같은 문제가 반복될 수 있습니다.",
      "균형 질문: ‘이 선택을 유도한 구조가 있다면 무엇일까?’",
    ],
  };

  if (axis === "S" && p === "Context") return {
    title: "기준: Context",
    body: [
      "동일 규칙보다 사정/맥락/예외를 고려합니다.",
      "강점: 현실적·인간적 판단(형평)에 강합니다.",
      "주의: 기준이 흔들려 보이면 편파로 오해될 수 있습니다.",
      "균형 질문: ‘이 예외를 다음에도 허용해도 괜찮을까?’",
    ],
  };
  if (axis === "S" && p === "Rule") return {
    title: "기준: Rule",
    body: [
      "맥락보다 원칙/동일 적용을 우선합니다.",
      "강점: 예측 가능성과 신뢰를 지키는 데 강합니다.",
      "주의: 현실 복잡성을 눌러버린다는 비판을 받을 수 있습니다.",
      "균형 질문: ‘이 규칙이 이 사례에서만 유난히 가혹해지진 않나?’",
    ],
  };

  if (axis === "H" && p === "Meaning") return {
    title: "해석: Meaning",
    body: [
      "사건을 미래 신호/변화의 계기로 해석합니다.",
      "강점: 소모를 줄이고 ‘다음 액션’을 설계합니다.",
      "주의: 책임·피해 감정을 건너뛰는 것처럼 보일 수 있습니다.",
      "균형 질문: ‘책임을 분명히 해야 변화도 설득력을 얻지 않나?’",
    ],
  };
  // Fault
  return {
    title: "해석: Fault",
    body: [
      "먼저 누가 잘못했고 책임져야 하는지 정리합니다.",
      "강점: 규범 회복과 사건 종결이 빠릅니다.",
      "주의: 미래 설계가 부족하면 형태만 바뀐 반복이 생길 수 있습니다.",
      "균형 질문: ‘처벌 이후 무엇을 바꿔야 재발이 막히지?’",
    ],
  };
}

function cviComment(level: CVILevel) {
  if (level === "HIGH") return [
    "상황 전환형: 이슈 종류에 따라 관점 스위칭이 큽니다.",
    "장점: 상황 적합도가 높습니다.",
    "팁: ‘왜 지금은 이 방식으로 보는지’를 한 문장으로 설명하면 오해가 줄어듭니다.",
  ];
  if (level === "MEDIUM") return [
    "상황 민감형: 특정 축에서만 전환이 발생합니다.",
    "장점: 핵심은 유지하면서 필요한 곳만 조정합니다.",
    "팁: 전환되는 축을 자각하면 ‘내 판단의 이유’를 설명하기 쉬워집니다.",
  ];
  return [
    "안정형: 상황이 달라도 관점이 비교적 일정합니다.",
    "장점: 예측 가능하고 설득 구조가 안정적입니다.",
    "팁: 상황 적합성을 놓치지 않도록 ‘반대 축 질문’을 한 번만 추가해보세요.",
  ];
}

export function buildIrtInterpretation(params: {
  scores: Scores;                  // base 점수
  typeCode: string;
  typeLabel: string;               // irtTypeCopy 결과
  cviLevel: CVILevel;
  keySummary: string;              // 너가 만든 한 줄 요약
}) {
  const { scores, typeCode, typeLabel, cviLevel, keySummary } = params;

  const flow = (["I","C","S","H"] as const).map((ax) => axisDetail(ax, scores[ax]));

  // 편차 큰 축 2개만 골라 강점/주의를 요약(너무 길어지지 않게)
  const ranked = (Object.entries(scores) as [keyof Scores, number][])
    .sort((a,b) => Math.abs(b[1]-50) - Math.abs(a[1]-50))
    .slice(0,2)
    .map(([ax]) => axisDetail(ax, scores[ax]).title);

  return {
    header: {
      typeCode,
      typeLabel,
      keySummary,
      highlightAxes: ranked,
    },
    flow,                 // 4단계 상세(각 4줄)
    cvi: cviComment(cviLevel),
  };
}
