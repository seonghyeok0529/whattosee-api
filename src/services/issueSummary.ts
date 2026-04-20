// src/services/issueSummary.ts
import prisma from "../lib/prisma.js";
import { openai, DEFAULT_MODEL } from "../lib/openai.js";

type SummarizeOptions = {
  force?: boolean;
  ttlMinutes?: number;
  locale?: "ko" | "en";
};

const DEFAULT_TTL_MIN = 360; // 6 hours

/** Utility: truncate text */
function clip(str?: string | null, max = 4000) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) : str;
}

export async function getOrCreateIssueSummary(issueId: string, opts: SummarizeOptions = {}) {
  const { force = false, ttlMinutes = DEFAULT_TTL_MIN, locale = "ko" } = opts;

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    include: {
      sources: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { outlet: true, title: true, url: true, side: true, createdAt: true },
      },
    },
  });
  if (!issue) throw new Error("ISSUE_NOT_FOUND");

  // ---------- 1) Cache ----------
  if (!force && issue.summary) {
    const summaryGeneratedAt = issue.updatedAt ? new Date(issue.updatedAt) : null;
    const hasNewSourceData =
      summaryGeneratedAt === null
        ? issue.sources.length > 0
        : issue.sources.some((s) => s.createdAt.getTime() > summaryGeneratedAt.getTime());

    if (!hasNewSourceData) {
      return { summary: issue.summary, cached: true };
    }

    const fresh =
      issue.updatedAt &&
      (Date.now() - new Date(issue.updatedAt).getTime()) / (1000 * 60) < ttlMinutes;
    if (fresh) return { summary: issue.summary, cached: true };
  }

  // ---------- 2) Build prompt materials (NO article body) ----------
  const title = issue.title ?? "";

  const headlines = issue.sources
    .map((s, i) => {
      const sideLabel =
        s.side === "left" ? "(진보 성향 추정)" :
        s.side === "right" ? "(보수 성향 추정)" :
        "";
      return `- [${i + 1}] ${s.outlet ?? "출처 미상"} ${sideLabel}: ${s.title ?? "(제목 없음)"} — ${s.url ?? ""}`;
    })
    .join("\n");

  const headlinesBlock = clip(headlines, 3000);

  // ---------- 3) System prompt ----------
  const system = locale === "ko"
    ? "너는 정치·사회 이슈를 중립적으로 요약하는 전문가다. 입력된 문장을 그대로 베끼지 말고, 새로운 문장으로 작성해야 한다. 특정 기사를 직접 요약하거나 인용해서는 안 된다. 주어진 헤드라인과 출처 목록을 바탕으로, 이 이슈 전체의 맥락을 추론하여 요약하라."
    : "You are an expert assistant summarizing issues neutrally. Never copy sentences verbatim. Do not summarize or quote any specific article. Use only the list of headlines/outlets to infer the issue context and produce a fresh summary.";

  // ---------- 4) User prompt (HEADLINE-based summary) ----------
  const user = [
    locale === "ko"
      ? "다음 헤드라인과 출처 목록을 기반으로 이 이슈의 전체 맥락을 중립적으로 요약해줘."
      : "Using the following headlines, summarize this issue neutrally.",
    "",
    title ? `이슈 제목: ${title}` : "",
    headlinesBlock ? `관련 기사 헤드라인:\n${headlinesBlock}` : "",
    "",
    locale === "ko"
      ? [
          "요약 조건:",
          "1) 배경·쟁점을 1~2문장으로 설명",
          "2) 주요 논점과 상반된 시각을 균형 있게 요약",
          "3) 확인된 사실 vs 주장 구분",
          "4) 감정적/선동적 표현 금지",
          "5) 마지막에 '주의할 점' 또는 불확실성 1문장",
        ].join("\n")
      : [
          "Requirements:",
          "1) Provide 1–2 sentences of context and background",
          "2) Present key arguments from multiple perspectives",
          "3) Separate verified facts from claims",
          "4) Avoid emotional or loaded language",
          "5) End with one caveat or uncertainty",
        ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n");

  // ---------- 5) Generate summary (HEADLINE-ONLY) ----------
  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  let summary =
    completion.choices?.[0]?.message?.content?.trim() ||
    (locale === "ko" ? "요약 생성 실패" : "Failed to generate summary");

  // ---------- 6) Double-check with issue.body ----------
  const body = clip(issue.body, 3500);

  if (body) {
    const validatePrompt = `
다음은 AI가 생성한 요약문입니다:

[요약문]
${summary}

그리고 아래는 참고용 본문(크롤링된 기사들의 일부 또는 관련 텍스트)입니다:

[본문 일부]
${body}

너의 역할:
- 요약문이 본문의 핵심 내용과 모순되는지 검증
- 본문 내용을 '요약'하거나 '재작성'하지 말 것
- 표현을 그대로 복사하지 말 것
- 요약문의 큰 오류만 지적하고, 필요한 경우 새로운 문장으로 수정 제안

출력:
1) "정확함 / 부분 오류 / 심각한 오류" 중 하나
2) 수정된 요약문 (필요한 경우에만)
    `.trim();

    const validation = await openai.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: "You are a verifier who checks accuracy without rewriting article content." },
        { role: "user", content: validatePrompt },
      ],
    });

    const validated = validation.choices?.[0]?.message?.content?.trim();

    if (validated && validated.includes("수정된 요약문")) {
      summary = validated.split("수정된 요약문")[1].trim();
    }
  }

  // ---------- 7) Save ----------
  await prisma.issue.update({
    where: { id: issueId },
    data: { summary },
  });

  return { summary, cached: false };
}
