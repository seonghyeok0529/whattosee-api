export type IrtAxis = "I" | "C" | "S" | "H";
export type IrtLayer = "base" | "scenario";
export type IrtScenario = "personal" | "public" | "risk";

export interface IRTOption {
  key: "A" | "B";
  text: string;
  pole: "left" | "right";
}

export interface IRTQuestion {
  id: string;
  axis: IrtAxis;
  dir: 1 | -1;
  layer: IrtLayer;
  scenario?: IrtScenario;
  type?: "likert" | "switch" | "forced";
  question: string;
  prompt?: string;
  options?: IRTOption[];
}

export const irtQuestions: IRTQuestion[] = [
  { id: "i1", axis: "I", dir: -1, layer: "base", question: "‘큰 흐름/추세’를 먼저 잡기보다, ‘현장의 장면/표정/대화’가 먼저 떠오르는 쪽에 가깝다." },
  { id: "i2", axis: "I", dir: +1, layer: "base", question: "‘현장의 장면/대화’를 보기보다, ‘통계·비율·추세(패턴)’를 먼저 확인하는 쪽에 가깝다." },
  { id: "i3", axis: "I", dir: -1, layer: "base", question: "‘요약 결론’으로 이해하기보다, ‘사람/장면 디테일’이 있어야 납득이 더 빠르다." },
  { id: "i4", axis: "I", dir: +1, layer: "base", question: "‘디테일을 쌓아가며 이해’하기보다, ‘큰 그림(맥락/패턴)을 잡은 뒤 채우는 방식’이 편하다." },
  { id: "i5", axis: "I", dir: -1, layer: "base", question: "‘분포/평균/추세’보다, ‘대표 사례 1~2개(장면)’가 내 판단에 더 크게 남는다." },
  { id: "i6", axis: "I", dir: +1, layer: "base", question: "‘대표 사례(장면)’보다, ‘반복 패턴(비율/추세)’이 더 설득력 있게 들어온다." },
  { id: "i7", axis: "I", dir: -1, layer: "base", question: "‘왜 그런 감정이 생겼는지(원인 구조)’를 먼저 묻기보다, ‘무슨 감정/무슨 상황인지(사연 디테일)’를 먼저 훑는 편이다." },
  { id: "i8", axis: "I", dir: +1, layer: "base", question: "‘개별 사연(디테일)’보다, ‘비슷한 사례가 얼마나 반복되는지(패턴)’가 먼저 궁금해진다." },
  { id: "i10", axis: "I", dir: +1, layer: "base", question: "‘직감으로 결론’을 내리기보다, ‘비교 기준/데이터/맥락’을 확보한 뒤에 판단 확신이 생긴다." },
  { id: "i11", axis: "I", dir: -1, layer: "scenario", scenario: "personal", question: "[개인 사건] ‘전체 맥락 요약’부터 보기보다, ‘무슨 말/행동이 오갔는지(장면)’부터 먼저 확인한다." },
  { id: "i12", axis: "I", dir: -1, layer: "scenario", scenario: "personal", question: "[개인 사건] ‘원인·결론 정리’보다, ‘감정 변화/관계 디테일’이 먼저 눈에 들어온다." },
  { id: "i13", axis: "I", dir: +1, layer: "scenario", scenario: "public", question: "[공공 이슈] ‘개별 사례 기사’보다, ‘통계/제도/배경(큰 흐름)’부터 먼저 잡는다." },
  { id: "i14", axis: "I", dir: +1, layer: "scenario", scenario: "public", question: "[공공 이슈] ‘현장 장면/증언’보다, ‘유사 사건의 반복(패턴)’을 먼저 확인한다." },
  { id: "i9", axis: "I", dir: -1, layer: "scenario", scenario: "risk", question: "[위험 상황] ‘원인 분석/구조’보다, ‘지금 보이는 위험 단서(피해/위협 디테일)’가 먼저 들어온다." },
  { id: "i15", axis: "I", dir: -1, layer: "scenario", scenario: "risk", question: "[위험 상황] ‘전체 상황 정리’보다, ‘당장 위험한 요소(근접 단서)’부터 먼저 체크한다." },
  { id: "c1", axis: "C", dir: -1, layer: "base", question: "‘제도/환경 요인’을 먼저 보기보다, ‘개인의 선택/책임’에서 원인을 먼저 찾는 쪽이다." },
  { id: "c2", axis: "C", dir: +1, layer: "base", question: "‘개인 성향/의지’를 먼저 보기보다, ‘제도·환경·유인 구조’가 행동을 만든다고 먼저 본다." },
  { id: "c3", axis: "C", dir: -1, layer: "base", question: "‘환경이 이렇다’는 설명보다, ‘같은 환경에서도 선택은 갈린다’는 쪽이 더 핵심처럼 느껴진다." },
  { id: "c4", axis: "C", dir: +1, layer: "base", question: "‘그 사람의 성향’보다, ‘구조가 유지되면 결과가 반복된다’는 쪽에 더 비중을 둔다." },
  { id: "c5", axis: "C", dir: -1, layer: "base", question: "‘구조 설명’을 듣기보다, ‘누가 어떤 결정을 했는지(행위자)’부터 먼저 추적한다." },
  { id: "c6", axis: "C", dir: +1, layer: "base", question: "‘누가 실수했는지’보다, ‘왜 그런 결정이 나오기 쉬웠는지(구조/유인)’부터 먼저 찾는다." },
  { id: "c7", axis: "C", dir: +1, layer: "base", question: "‘개인 평가(좋다/나쁘다)’보다, ‘구조적 조건(규칙/인센티브)’부터 먼저 점검하는 편이다." },
  { id: "c8", axis: "C", dir: -1, layer: "base", question: "‘구조 설명이 충분해도’ ‘책임이 흐려질 수 있다’는 점이 먼저 걸리는 편이다." },
  { id: "c10", axis: "C", dir: +1, layer: "base", question: "‘악의/의도’보다, ‘구조적 허점/설계 결함’에서 문제가 반복된다고 더 자주 느낀다." },
  { id: "c9", axis: "C", dir: -1, layer: "scenario", scenario: "personal", question: "[개인 사건] ‘관계 구조/압박’보다, ‘당사자의 선택/태도’에서 원인을 먼저 찾는다." },
  { id: "c11", axis: "C", dir: +1, layer: "scenario", scenario: "personal", question: "[개인 사건] ‘당사자 성격’보다, ‘관계 구조/압박/유인’에서 원인을 먼저 찾는다." },
  { id: "c12", axis: "C", dir: +1, layer: "scenario", scenario: "public", question: "[공공 이슈] ‘특정 인물의 의도’보다, ‘제도/환경/유인 구조’가 만든 결과로 먼저 본다." },
  { id: "c13", axis: "C", dir: -1, layer: "scenario", scenario: "public", question: "[공공 이슈] ‘제도/환경’보다, ‘책임 있는 개인의 결정’에 원인을 먼저 두는 편이다." },
  { id: "c14", axis: "C", dir: +1, layer: "scenario", scenario: "risk", question: "[위험 상황] ‘개인의 실수/일탈’보다, ‘관리·감독·안전 시스템의 구멍’에서 원인을 먼저 찾는다." },
  { id: "c15", axis: "C", dir: -1, layer: "scenario", scenario: "risk", question: "[위험 상황] ‘시스템 허점’보다, ‘개인의 중대한 부주의/규정 위반’이 원인이라는 쪽이 먼저 떠오른다." },
  { id: "s1", axis: "S", dir: -1, layer: "base", question: "‘예외 사정’보다, ‘기준의 일관성이 무너질 위험’이 먼저 걸린다." },
  { id: "s2", axis: "S", dir: +1, layer: "base", question: "‘규칙을 즉시 적용’하기보다, ‘맥락/사정 확인 후 적용’이 더 합리적으로 느껴진다." },
  { id: "s3", axis: "S", dir: -1, layer: "base", question: "‘사정/맥락’보다, ‘규칙/원칙’이 판단의 출발점이 되는 편이다." },
  { id: "s4", axis: "S", dir: +1, layer: "base", question: "‘원칙 고정’보다, ‘사정/맥락 점검’이 먼저 들어가야 판단이 가능하다." },
  { id: "s5", axis: "S", dir: -1, layer: "base", question: "‘상황별 조정’보다, ‘동일 기준의 동일 적용’이 공정하다고 더 느낀다." },
  { id: "s6", axis: "S", dir: +1, layer: "base", question: "‘기계적 동일 적용’보다, ‘상황에 맞춘 조정’이 더 정밀한 공정이라고 느끼는 편이다." },
  { id: "s8", axis: "S", dir: +1, layer: "base", question: "‘엄격한 기준’보다, ‘현실을 반영한 유연 적용’이 더 타당해 보일 때가 많다." },
  { id: "s9", axis: "S", dir: -1, layer: "base", question: "‘맥락을 길게 따지기’보다, ‘기준의 일관성 확보’가 먼저 필요하다고 느낀다." },
  { id: "s10", axis: "S", dir: +1, layer: "base", question: "‘원칙을 먼저 세우기’보다, ‘개별 상황의 맥락을 먼저 확인’하고 판단하고 싶다." },
  { id: "s12", axis: "S", dir: +1, layer: "scenario", scenario: "personal", question: "[개인 사건] ‘선을 넘었는지’보다, ‘왜 그런 상황이 되었는지(사정)’를 먼저 확인한다." },
  { id: "s13", axis: "S", dir: -1, layer: "scenario", scenario: "personal", question: "[개인 사건] ‘사정/맥락’보다, ‘기준 위반 여부(선을 넘었는지)’를 먼저 확인한다." },
  { id: "s11", axis: "S", dir: -1, layer: "scenario", scenario: "public", question: "[공공 이슈] ‘현실 제약’보다, ‘원칙/규정/기준’부터 먼저 확인한 뒤 판단한다." },
  { id: "s14", axis: "S", dir: +1, layer: "scenario", scenario: "public", question: "[공공 이슈] ‘규정 조항’보다, ‘현실 제약/불가피한 맥락’부터 먼저 확인한 뒤 판단한다." },
  { id: "s7", axis: "S", dir: -1, layer: "scenario", scenario: "risk", question: "[위험 상황] ‘현장 사정’보다, ‘매뉴얼/규정 위반 여부’부터 먼저 확인한다." },
  { id: "s15", axis: "S", dir: +1, layer: "scenario", scenario: "risk", question: "[위험 상황] ‘규정 준수 여부’보다, ‘현장 정보 부족/순간 판단의 맥락’부터 먼저 확인한다." },
  { id: "h1", axis: "H", dir: -1, layer: "base", question: "‘변화 포인트/개선안’보다, ‘누가 어디서 잘못했는지(책임 단서)’를 먼저 정리하고 싶다." },
  { id: "h2", axis: "H", dir: +1, layer: "base", question: "‘책임 정리’보다, ‘앞으로의 변화 신호/파장(후폭풍)’을 먼저 읽고 싶다." },
  { id: "h3", axis: "H", dir: -1, layer: "base", question: "‘대안 설계’보다, ‘책임 소재가 명확해져야’ 다음 단계로 넘어갈 수 있다고 느낀다." },
  { id: "h4", axis: "H", dir: +1, layer: "base", question: "‘책임을 가르기’보다, ‘이번 사건이 드러낸 취약점/흐름’을 먼저 본다." },
  { id: "h5", axis: "H", dir: -1, layer: "base", question: "‘교훈/개선’을 뽑기보다, ‘정확한 책임 소재와 과오’를 분명히 해야 정의가 선다고 느낀다." },
  { id: "h6", axis: "H", dir: +1, layer: "base", question: "‘과오를 따지기’보다, ‘재발을 막는 교훈/개선 포인트’를 뽑는 쪽이 더 중요하다고 느낀다." },
  { id: "h7", axis: "H", dir: -1, layer: "base", question: "‘재발 방지 설계’보다, ‘단호한 책임 정리/조치’가 위험 제거에 더 직접적이라고 느낀다." },
  { id: "h8", axis: "H", dir: +1, layer: "base", question: "‘단죄/응징’보다, ‘앞으로 무엇을 바꿔야 하는지(개선 방향)’가 먼저 궁금해진다." },
  { id: "h10", axis: "H", dir: +1, layer: "base", question: "‘현재의 잘못 정리’보다, ‘앞으로의 파장/변화’가 먼저 떠오르는 편이다." },
  { id: "h11", axis: "H", dir: -1, layer: "scenario", scenario: "personal", question: "[개인 사건] ‘관계의 다음 흐름’보다, ‘사과/책임 정리/관계 조치’가 먼저 필요하다고 느낀다." },
  { id: "h12", axis: "H", dir: +1, layer: "scenario", scenario: "personal", question: "[개인 사건] ‘책임 정리’보다, ‘앞으로 관계가 바뀔 신호/패턴’이 먼저 떠오른다." },
  { id: "h9", axis: "H", dir: +1, layer: "scenario", scenario: "public", question: "[공공 이슈] ‘누가 책임져야 하는지’보다, ‘무엇을 바꿔야 하는지(개선/대안)’가 먼저 떠오른다." },
  { id: "h13", axis: "H", dir: -1, layer: "scenario", scenario: "public", question: "[공공 이슈] ‘개선/대안’보다, ‘누가 책임져야 하는지(책임 소재)’가 먼저 떠오른다." },
  { id: "h14", axis: "H", dir: -1, layer: "scenario", scenario: "risk", question: "[위험 상황] ‘재발 방지 설계’보다, ‘책임자 규명/책임선 긋기’가 먼저 떠오른다." },
  { id: "h15", axis: "H", dir: +1, layer: "scenario", scenario: "risk", question: "[위험 상황] ‘책임자 규명’보다, ‘재발 방지 포인트/경고 신호’가 먼저 떠오른다." },
  { id: "t1", axis: "I", dir: +1, layer: "scenario", type: "switch", question: "이슈를 볼 때, ‘장면/사연’보다 ‘큰 흐름/반복 패턴’이 먼저 잡힌다." },
  { id: "t3", axis: "I", dir: -1, layer: "scenario", type: "switch", question: "이슈를 볼 때, ‘큰 흐름/패턴’보다 ‘장면/사람 디테일’이 먼저 들어온다." },
  { id: "t4", axis: "C", dir: +1, layer: "scenario", type: "switch", question: "원인을 볼 때, ‘개인의 태도’보다 ‘구조/제도 요인’이 먼저 떠오른다." },
  { id: "t6", axis: "C", dir: -1, layer: "scenario", type: "switch", question: "원인을 볼 때, ‘구조/제도’보다 ‘개인의 선택/태도’가 먼저 떠오른다." },
  { id: "t7", axis: "S", dir: +1, layer: "scenario", type: "switch", question: "판단할 때, ‘원칙/규정’보다 ‘맥락/사정’ 반영이 더 우선이라고 느낀다." },
  { id: "t9", axis: "S", dir: -1, layer: "scenario", type: "switch", question: "판단할 때, ‘맥락/사정’보다 ‘원칙/일관 적용’이 더 우선이라고 느낀다." },
  { id: "t10", axis: "H", dir: +1, layer: "scenario", type: "switch", question: "해석할 때, ‘책임 규명’보다 ‘다음 신호/교훈(개선)’이 먼저 떠오른다." },
  { id: "t12", axis: "H", dir: -1, layer: "scenario", type: "switch", question: "해석할 때, ‘교훈/개선’보다 ‘책임 소재/과오’가 먼저 떠오른다." },
  {
    id: "fI1", axis: "I", dir: +1, layer: "scenario", type: "forced", question: "아래 두 진술 중 나에게 더 가까운 쪽을 고르세요.", prompt: "유입(I) - 강제 선택",
    options: [
      { key: "A", text: "장면/사람 디테일(말·표정)이 먼저 잡힌다.", pole: "left" },
      { key: "B", text: "큰 흐름/반복 패턴(추세·비율)이 먼저 잡힌다.", pole: "right" },
    ],
  },
  {
    id: "fC1", axis: "C", dir: +1, layer: "scenario", type: "forced", question: "아래 두 진술 중 나에게 더 가까운 쪽을 고르세요.", prompt: "원인(C) - 강제 선택",
    options: [
      { key: "A", text: "원인은 개인의 선택/책임에서 더 많이 나온다.", pole: "left" },
      { key: "B", text: "원인은 제도/환경/유인 구조에서 더 많이 나온다.", pole: "right" },
    ],
  },
  {
    id: "fS1", axis: "S", dir: +1, layer: "scenario", type: "forced", question: "아래 두 진술 중 나에게 더 가까운 쪽을 고르세요.", prompt: "기준(S) - 강제 선택",
    options: [
      { key: "A", text: "원칙/일관 적용이 우선이고, 예외는 최소화해야 한다.", pole: "left" },
      { key: "B", text: "맥락/사정 반영이 우선이고, 적용은 조정될 수 있다.", pole: "right" },
    ],
  },
  {
    id: "fH1", axis: "H", dir: +1, layer: "scenario", type: "forced", question: "아래 두 진술 중 나에게 더 가까운 쪽을 고르세요.", prompt: "해석(H) - 강제 선택",
    options: [
      { key: "A", text: "책임 소재/과오를 먼저 분명히 해야 다음으로 갈 수 있다.", pole: "left" },
      { key: "B", text: "교훈/개선을 먼저 찾아야 다음으로 갈 수 있다.", pole: "right" },
    ],
  },
];
