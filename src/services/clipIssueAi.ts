// src/services/clipIssueAi.ts
import prisma from "../lib/prisma.js";
import { openai, DEFAULT_MODEL } from "../lib/openai.js";
import { generateGlossaryText } from "./generateGlossary.js";

function take(str?: string | null, max = 4000) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) : str;
}

/* -------------------------------------------------------
 * 1) AI 제목 생성
 *  - 여러 클립의 제목만 이용 (자막/본문 사용 X)
 * ----------------------------------------------------- */
export async function generateClipIssueTitle(clipIssueId: string) {
  const issue = await prisma.clipIssue.findUnique({
    where: { id: clipIssueId },
    include: {
      clips: {
        include: { rawClip: true },
        take: 10,
      },
    },
  });

  if (!issue) throw new Error("CLIP_ISSUE_NOT_FOUND");

  const titles = issue.clips
    .map((c) => c.rawClip?.title?.trim())
    .filter(Boolean)
    .slice(0, 15)
    .join("\n");

  if (!titles) return issue.title ?? "";

  const prompt = `
다음은 같은 이슈에 속한 여러 유튜브/방송 뉴스 제목들이다.
제목과 채널 정보를 바탕으로, 이 이슈의 핵심을 15자 이내로 요약한 ‘이슈 제목’을 만들어라.

조건:
- 15자 이내
- 중복·군더더기 제거
- ~~사건, ~~논란, ~~공방 등 표현 가능
- 밋밋한 제목(너무 일반적인 표현)은 피할 것
- 입력된 제목 문장을 그대로 베끼지 말 것. 항상 새로운 표현으로 작성할 것.

제목들:
${titles}

이슈 제목:
  `.trim();

  const res = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    max_tokens: 50,
    temperature: 0.4,
    messages: [
      { role: "system", content: "너는 한국 뉴스 제목 요약 전문가다." },
      { role: "user", content: prompt },
    ],
  });

  return res.choices?.[0]?.message?.content?.trim() ?? issue.title;
}

/* -------------------------------------------------------
 * 2) 중립 AI Summary 생성 → ClipIssue.aiSummary 저장
 *  - 클립 제목/채널/성향(메타 정보) 기반 이슈 요약
 *  - 실제 영상 내용/자막/본문은 생성에 사용하지 않음
 * ----------------------------------------------------- */
export async function generateClipIssueSummary(clipIssueId: string) {
  const issue = await prisma.clipIssue.findUnique({
    where: { id: clipIssueId },
    include: {
      clips: {
        include: { rawClip: true },
        take: 18,
      },
    },
  });

  if (!issue) throw new Error("CLIP_ISSUE_NOT_FOUND");

  const clipLines = issue.clips
    .map((c, i) => {
      const r = c.rawClip;
      if (!r) return "";
      const side =
        r.side === "left"
          ? "(진보)"
          : r.side === "right"
          ? "(보수)"
          : r.side === "center"
          ? "(중도)"
          : "(중립)";
      const channel = r.channel ?? "채널";
      const title = r.title ?? "(제목 없음)";
      return `- [${i + 1}] ${channel} ${side}: ${title}`;
    })
    .filter(Boolean)
    .join("\n");

  if (!clipLines) return "";

  const clippedList = take(clipLines, 3500);

  const prompt = `
다음은 여러 방송/유튜브 뉴스 클립을 묶은 '뉴스 클립 이슈'이다.
제목과 채널, 성향 정보를 단서로 이 이슈의 전체 맥락을 2~3문장으로 중립적으로 요약해라.

주의:
- 실제 영상을 본 것처럼 세부 발언 내용을 인용하거나 상상하지 말 것
- 개별 클립의 구체적인 내용을 요약하려 하지 말 것
- 제목과 채널, 성향 정보에서 유추되는 '이슈의 주제·쟁점·갈등 구조'를 설명할 것
- 입력된 제목 문장을 그대로 베끼지 말고, 새로운 문장으로 작성할 것
- 감정적·선동적 표현은 피하고, 분석적 톤을 유지할 것

이슈 제목:
${issue.title ?? "(제목 없음)"}

참고 클립 목록:
${clippedList}

요약 규칙:
- 쟁점/맥락을 1~2문장으로 설명
- 서로 다른 입장(예: 정부/야당, 이해관계자들)이 있다면 균형 있게 언급
- 확인된 사실/사실로 보도되는 부분과, 해석·주장을 구분해 서술
- 마지막에 '주의할 점' 또는 논쟁 지점을 1문장으로 덧붙일 것
  `.trim();

  const res = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "너는 정치·사회 이슈를 중립적으로 요약하는 보조자다. 입력 텍스트의 문장을 그대로 베끼지 말고 항상 새로운 문장으로 작성해야 한다.",
      },
      { role: "user", content: prompt },
    ],
  });

  const summary = res.choices?.[0]?.message?.content?.trim() ?? "";

  await prisma.clipIssue.update({
    where: { id: clipIssueId },
    data: {
      aiSummary: summary,
    },
  });

  return summary;
}

/* -------------------------------------------------------
 * 3) 진보 / 보수 프레임 요약
 *  - 특정 클립 '내용' 요약이 아니라, 성향별 전형적 관점/프레임 설명
 *  - 제목/채널 목록만 사용
 *  - 최소 2개 이상 클립 있을 때만 생성 (1개면 스킵)
 * ----------------------------------------------------- */
export async function generateClipIssueSideSummary(
  clipIssueId: string,
  side: "left" | "right"
) {
  const clips = await prisma.clipIssueClip.findMany({
    where: { clipIssueId, side },
    include: { rawClip: true },
    take: 15,
  });

  if (clips.length < 2) {
    // 한 개만 있을 때는 특정 클립 요약처럼 보일 수 있으므로 생성하지 않음
    return "";
  }

  const sideLabel = side === "left" ? "진보" : "보수";

  const list = clips
    .map((c, i) => {
      const channel = c.rawClip?.channel ?? "채널";
      const title = c.rawClip?.title ?? "(제목 없음)";
      return `[${i + 1}] (${channel}) ${title}`;
    })
    .filter(Boolean)
    .join("\n");

  const clippedList = take(list, 3500);

  const prompt = `
다음은 모두 "${sideLabel} 성향"으로 분류된 유튜브/방송 뉴스 클립들이다.
제목과 채널 정보를 단서로, "${sideLabel} 성향"이 이 이슈를 바라볼 때
일반적으로 취할 수 있는 전형적인 관점과 논조를 2~3문장으로 정리하라.

주의:
- 실제 영상을 본 것처럼 구체적인 발언이나 장면을 인용하지 말 것
- 개별 클립의 내용을 요약하려 하지 말고, "${sideLabel} 성향" 채널들이
  이와 같은 이슈에서 보이는 전형적인 해석 틀(프레임)을 설명할 것
- 입력된 제목 문장을 그대로 반복하지 말고, 새로운 문장으로 작성할 것
- 상대 진영을 공격하거나 조롱하는 표현은 피하고, 분석적으로 서술할 것

클립 제목 & 채널 목록:
${clippedList}

출력 형식:
- 2~3문장 분량의 한글 문단 하나
- "${sideLabel}" 성향이 이 이슈를 어떤 관점/우려/강조점으로 보는지를 설명
  `.trim();

  const r = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "너는 뉴스 논조와 이념적 프레임을 분석하는 전문가다. 특정 클립의 내용을 요약하는 대신, 성향별 전형적 관점을 설명해야 한다.",
      },
      { role: "user", content: prompt },
    ],
  });

  return r.choices?.[0]?.message?.content?.trim() ?? "";
}

/* -------------------------------------------------------
 * 4) ClipIssue 전체 AI 필드 재생성 (+ glossaryText)
 * ----------------------------------------------------- */
export async function refreshClipIssueAIFields(clipIssueId: string) {
  // 제목 / 요약 / 좌·우 프레임 요약 병렬 생성
  const [title, aiSummary, progressive, conservative] = await Promise.all([
    generateClipIssueTitle(clipIssueId),
    generateClipIssueSummary(clipIssueId),
    generateClipIssueSideSummary(clipIssueId, "left"),
    generateClipIssueSideSummary(clipIssueId, "right"),
  ]);

  // 1차 업데이트: 기본 AI 필드 + 클립 목록 로드
  const updatedBase = await prisma.clipIssue.update({
    where: { id: clipIssueId },
    data: {
      title,
      aiSummary,
      progressiveSummary: progressive || null,
      conservativeSummary: conservative || null,
    },
    include: {
      clips: {
        include: { rawClip: true },
        take: 18,
      },
    },
  });

  // glossary용 클립 목록 텍스트 구성 (설명용이므로 메타 정보 위주)
  const clipsText = updatedBase.clips
    .map((ic) => {
      const ch = ic.rawClip?.channel ?? "채널";
      const t = ic.rawClip?.title ?? "(제목 없음)";
      return `- [${ch}] ${t}`;
    })
    .join("\n");

  const glossaryText = await generateGlossaryText({
    title: updatedBase.title,
    // aiSummary가 있으면 우선 사용, 없으면 description 사용 (description은 운영 정책에 따라 관리)
    summary: updatedBase.aiSummary ?? updatedBase.description ?? null,
    itemsText: clipsText,
    locale: "ko",
    sourceType: "clip",
  });

  // glossaryText만 별도 업데이트
  await prisma.clipIssue.update({
    where: { id: clipIssueId },
    data: {
      // @ts-ignore: ClipIssue 모델에 glossaryText 필드 있다고 가정
      glossaryText,
    },
  });

  // 라우터에서 (updated as any).glossaryText 로 접근 가능하도록 합쳐서 반환
  return {
    ...updatedBase,
    // @ts-ignore
    glossaryText,
  } as any;
}
