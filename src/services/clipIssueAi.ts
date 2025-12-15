// src/services/clipIssueAi.ts
import prisma from "../lib/prisma.js";
import { openai, DEFAULT_MODEL } from "../lib/openai.js";
import { generateGlossaryText } from "./generateGlossary.js";

function take(str?: string | null, max = 4000) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) : str;
}

/* ─────────────────────────────────────────
   glossaryText를 항상 "JSON 문자열"로 정규화
───────────────────────────────────────── */
type GlossaryItem = { term: string; definition: string };

function normalizeGlossaryTextToJsonString(input: any): string | null {
  if (input == null) return null;

  // input이 배열이면 -> term/definition만 정제해서 JSON.stringify
  if (Array.isArray(input)) {
    const items: GlossaryItem[] = input
      .filter(
        (x) => x && typeof x.term === "string" && typeof x.definition === "string"
      )
      .map((x) => ({
        term: x.term.trim().slice(0, 80),
        definition: x.definition.trim().slice(0, 300),
      }));

    return items.length ? JSON.stringify(items) : null;
  }

  // 문자열이 아니면 저장 불가
  if (typeof input !== "string") return null;

  const s = input.trim();
  if (!s) return null;

  // 문자열이 JSON 배열이면 재귀로 정규화
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return normalizeGlossaryTextToJsonString(parsed);
    }
  } catch {
    // not json
  }

  // JSON이 아니면 저장하지 않음(= null). 프론트 파싱 실패 방지.
  return null;
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
 *  - 생성: 제목/채널/성향(메타)만 사용
 *  - 검증: 원본(description 등)을 이용해 큰 오류만 체크
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

  // 2-1) 메타 정보 기반 요약 생성
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

  const summaryPrompt = `
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
      { role: "user", content: summaryPrompt },
    ],
  });

  let summary = res.choices?.[0]?.message?.content?.trim() ?? "";

  // 2-2) 원본 데이터(설명 등)로 요약 검증 (선택적)
  const descriptionBlock = take(issue.description, 2000);

  if (descriptionBlock && summary) {
    const validatePrompt = `
다음은 뉴스 클립 이슈에 대해 AI가 생성한 요약문이다:

[요약문]
${summary}

아래는 이 이슈를 설명하기 위해 수집된 참고 설명 텍스트이다
(여러 클립 설명을 합친 것일 수 있음):

[설명 텍스트 일부]
${descriptionBlock}

너의 역할:
- 요약문이 설명 텍스트의 핵심과 크게 모순되지 않는지 검증한다.
- 설명 텍스트의 문장을 그대로 베끼지 말 것.
- 설명 텍스트를 새로 요약하려고 하지 말고, '현재 요약문'이 틀린 부분만 잡아서 수정하는 데 집중할 것.

출력 형식:
1) 첫 줄에 아래 중 하나만 적을 것: "정확함" / "부분 오류" / "심각한 오류"
2) 둘째 줄부터, 필요하다면 수정된 요약문을 2~3문장으로 새로 작성한다.
   - 이때도 설명 텍스트의 표현을 그대로 베끼지 말 것.
    `.trim();

    const v = await openai.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "너는 요약문의 정확성을 검증하는 보조자다. 기사나 자막의 문장을 그대로 재작성하지 않는다.",
        },
        { role: "user", content: validatePrompt },
      ],
    });

    const validated = v.choices?.[0]?.message?.content?.trim();
    if (validated) {
      const [firstLine, ...rest] = validated.split("\n");
      const verdict = firstLine.trim();
      const maybeNewSummary = rest.join("\n").trim();
      if (
        (verdict === "부분 오류" || verdict === "심각한 오류") &&
        maybeNewSummary.length > 0
      ) {
        summary = maybeNewSummary;
      }
    }
  }

  await prisma.clipIssue.update({
    where: { id: clipIssueId },
    data: {
      aiSummary: summary,
    },
  });

  return summary;
}

/* -------------------------------------------------------
 * 3) 쟁점 리스트 생성 → "생성만" 하고 저장은 하지 않음
 *  - talkingPoints가 relation일 가능성 높아서 update 저장하면 언젠가 깨짐
 * ----------------------------------------------------- */
export async function generateClipIssueTalkingPoints(clipIssueId: string) {
  const issue = await prisma.clipIssue.findUnique({
    where: { id: clipIssueId },
    include: { clips: { include: { rawClip: true }, take: 12 } },
  });

  if (!issue) throw new Error("CLIP_ISSUE_NOT_FOUND");
  if (!issue.aiSummary) return "";

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
      return `- [${i + 1}] ${r.channel ?? "채널"} ${side}: ${r.title ?? "(제목 없음)"}`;
    })
    .filter(Boolean)
    .join("\n");

  const prompt = `
다음은 한 이슈에 대한 AI 요약문과 관련 뉴스 클립 목록이다.
이 정보를 바탕으로, 사용자가 '원본 영상을 볼 때 특히 주목하면 좋을 쟁점/질문 리스트'를 만들어라.

[이슈 요약문]
${issue.aiSummary}

[관련 클립 목록]
${clipLines}

요구사항:
- 3~7개 bullet
- 각 항목 1문장 이내
- 원본 내용을 대신 요약하지 말 것
- "무엇이 쟁점인지" + "무엇을 비교/비판적으로 생각할지" 중심

출력 형식:
- 마크다운 bullet 리스트 (- 로 시작)
  `.trim();

  const res = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content: "너는 시청자가 뉴스를 볼 때 중요한 쟁점과 질문을 짚어주는 가이드다.",
      },
      { role: "user", content: prompt },
    ],
  });

  // ✅ 저장하지 않고 반환만
  return res.choices?.[0]?.message?.content?.trim() ?? "";
}

/* -------------------------------------------------------
 * 4) ClipIssue 전체 AI 필드 재생성 (+ glossaryText)
 *  - glossaryText: JSON 문자열로 정규화해서 저장
 *  - talkingPoints: 생성만 해서 반환, 저장은 제거
 * ----------------------------------------------------- */
export async function refreshClipIssueAIFields(clipIssueId: string) {
  const [title, aiSummary] = await Promise.all([
    generateClipIssueTitle(clipIssueId),
    generateClipIssueSummary(clipIssueId),
  ]);

  const updatedBase = await prisma.clipIssue.update({
    where: { id: clipIssueId },
    data: { title, aiSummary },
    include: { clips: { include: { rawClip: true }, take: 18 } },
  });

  const clipsText = updatedBase.clips
    .map((ic) => `- [${ic.rawClip?.channel ?? "채널"}] ${ic.rawClip?.title ?? "(제목 없음)"}`)
    .join("\n");

  const rawGlossary = await generateGlossaryText({
    title: updatedBase.title,
    summary: updatedBase.aiSummary ?? updatedBase.description ?? null,
    itemsText: clipsText,
    locale: "ko",
    sourceType: "clip",
  });

  const glossaryJsonString = normalizeGlossaryTextToJsonString(rawGlossary);

  const final = await prisma.clipIssue.update({
    where: { id: clipIssueId },
    data: {
      glossaryText: glossaryJsonString,
      // ✅ talkingPoints 저장 제거 (relation/라우터 충돌 방지)
    },
  });

  // 필요하면 생성만 해서 반환
  const talkingPoints = await generateClipIssueTalkingPoints(clipIssueId);

  return {
    ...final,
    glossaryText: glossaryJsonString,
    talkingPoints, // ✅ 저장 X, 반환만
  } as any;
}

/* -------------------------------------------------------
 * 5) 클립 이슈 용어 사전만 재생성
 *  - glossaryText: JSON 문자열로 정규화해서 저장
 * ----------------------------------------------------- */
export async function refreshClipIssueGlossary(clipIssueId: string) {
  const issue = await prisma.clipIssue.findUnique({
    where: { id: clipIssueId },
    include: { clips: { include: { rawClip: true }, take: 18 } },
  });

  if (!issue) return null;

  const clipsText = (issue.clips ?? [])
    .map((ic) => `- [${ic.rawClip?.channel ?? "채널"}] ${ic.rawClip?.title ?? "(제목 없음)"}`)
    .join("\n");

  const rawGlossary = await generateGlossaryText({
    title: issue.title,
    summary: issue.aiSummary ?? issue.description ?? null,
    itemsText: clipsText,
    locale: "ko",
    sourceType: "clip",
  });

  const glossaryJsonString = normalizeGlossaryTextToJsonString(rawGlossary);

  return await prisma.clipIssue.update({
    where: { id: clipIssueId },
    data: { glossaryText: glossaryJsonString },
    select: { id: true, glossaryText: true },
  });
}
