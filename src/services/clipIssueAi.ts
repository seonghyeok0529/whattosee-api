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
    .join("\n");

  if (!titles) return issue.title ?? "";

  const prompt = `
다음은 같은 이슈에 속한 여러 유튜브/방송 뉴스 제목들이다.
핵심을 15자 이내로 요약한 ‘이슈 제목’을 만들어라.

조건
- 15자 이내
- 중복·군더더기 제거
- ~~사건, ~~논란, ~~공방 가능
- 밋밋 금지

제목들:
${titles}

이슈 제목:
  `.trim();

  const res = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    max_tokens: 50,
    temperature: 0.4,
    messages: [
      { role: "system", content: "너는 한국 뉴스 제목 요약 전문가다" },
      { role: "user", content: prompt },
    ],
  });

  return res.choices?.[0]?.message?.content?.trim() ?? issue.title;
}

/* -------------------------------------------------------
 * 2) 중립 AI Summary 생성 → ClipIssue.aiSummary 저장
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

  const body = take(issue.description, 2000);

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
      return `- [${i + 1}] ${r.channel ?? "채널"} ${side}: ${r.title}`;
    })
    .join("\n");

  const prompt = `
다음은 여러 방송/유튜브 뉴스 클립을 묶은 '뉴스 클립 이슈'이다.
이 내용을 편향 없이 2-3문장으로 요약해라.

이슈 설명:
${body}

참고 클립 목록:
${clipLines}

요약 규칙:
- 쟁점/맥락 1~2문장
- 핵심 주장 균형 있게
- 사실 vs 주장 구분
- 감정적 수사 금지
  `.trim();

  const res = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: "너는 정치·사회 이슈를 중립적으로 요약하는 보조자다.",
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
 * 3) 진보 / 보수 요약 → progressiveSummary, conservativeSummary 저장
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

  if (!clips.length) return "";

  const sideLabel = side === "left" ? "진보" : "보수";

  const list = clips
    .map(
      (c, i) =>
        `[${i + 1}] (${c.rawClip?.channel ?? "채널"}) ${c.rawClip?.title}`
    )
    .join("\n\n");

  const prompt = `
다음은 모두 "${sideLabel} 성향"의 유튜브/방송 뉴스 클립이다.
이들이 공통으로 주장하는 핵심을 2~3문장으로 객관적으로 정리하라.

${list}
`.trim();

  const r = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content: "너는 뉴스 논조 분석 전문가다." },
      { role: "user", content: prompt },
    ],
  });

  return r.choices?.[0]?.message?.content?.trim() ?? "";
}

/* -------------------------------------------------------
 * 4) ClipIssue 전체 AI 필드 재생성 (+ glossaryText)
 * ----------------------------------------------------- */
export async function refreshClipIssueAIFields(clipIssueId: string) {
  // 제목 / 요약 / 좌·우 요약은 병렬로 생성
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

  // glossary용 클립 목록 텍스트 구성
  const clipsText = updatedBase.clips
    .map((ic) => {
      const ch = ic.rawClip?.channel ?? "채널";
      const t = ic.rawClip?.title ?? "(제목 없음)";
      return `- [${ch}] ${t}`;
    })
    .join("\n");

  const glossaryText = await generateGlossaryText({
    title: updatedBase.title,
    // aiSummary가 있으면 우선 사용, 없으면 description 사용
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
