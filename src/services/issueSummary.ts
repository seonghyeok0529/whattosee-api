// src/services/issueSummary.ts
import prisma from "../lib/prisma.js";
import { openai, DEFAULT_MODEL } from "../lib/openai.js";

type SummarizeOptions = {
  force?: boolean;      // true면 항상 새로 생성
  ttlMinutes?: number;  // 캐시 유효기간(분)
  locale?: "ko" | "en";
};

const DEFAULT_TTL_MIN = 360; // 6시간

function takeText(str?: string | null, max = 4000) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) : str;
}

export async function getOrCreateIssueSummary(issueId: string, opts: SummarizeOptions = {}) {
  const { force = false, ttlMinutes = DEFAULT_TTL_MIN, locale = "ko" } = opts;

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    include: {
      sources: { select: { outlet: true, title: true, url: true, side: true }, take: 12 },
    },
  });
  if (!issue) throw new Error("ISSUE_NOT_FOUND");

  // 캐시 사용 (Issue.summary 필드)
  if (!force && issue.summary) {
    const isFresh =
      issue.updatedAt &&
      (Date.now() - new Date(issue.updatedAt).getTime()) / (1000 * 60) < ttlMinutes;
    if (isFresh) return { summary: issue.summary, cached: true };
  }

  // 프롬프트 재료 구성
  const body = takeText(issue.body, 4000);
  const srcLines = issue.sources.map((s, i) => {
    const side = s.side ? `(${s.side})` : "";
    return `- [${i + 1}] ${s.outlet ?? "출처"} ${side}: ${s.title}${s.url ? ` — ${s.url}` : ""}`;
  }).join("\n");

  const system = locale === "ko"
    ? "너는 정치·사회 이슈를 중립적으로 요약하는 보조자다. 사실 중심, 감정 과잉 금지, 6~8문장 내외."
    : "You are a neutral assistant summarizing political/social issues. Be factual, 6-8 sentences.";

  const user = [
    locale === "ko" ? "다음 이슈를 편향 없이 요약해줘." : "Summarize this issue neutrally.",
    "",
    issue.title ? `제목: ${issue.title}` : "",
    body ? `본문(일부):\n${body}` : "",
    srcLines ? `참고 출처 목록:\n${srcLines}` : "",
    "",
    locale === "ko"
      ? [
          "요구사항:",
          "1) 쟁점과 맥락을 먼저 1~2문장",
          "2) 입장/논거를 좌·우 모두 균형 있게",
          "3) 확인된 사실 vs 주장 구분",
          "4) 과도한 감정/수사는 금지",
          "5) 마지막에 '주의할 점' 1문장",
        ].join("\n")
      : [
          "Requirements:",
          "1) Start with context in 1-2 sentences",
          "2) Cover both sides' key arguments",
          "3) Separate verified facts vs claims",
          "4) Avoid loaded language",
          "5) End with a one-sentence caveat",
        ].join("\n"),
  ].filter(Boolean).join("\n");

  // OpenAI 호출
  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const summary =
    completion.choices?.[0]?.message?.content?.trim() ||
    (locale === "ko" ? "요약을 생성하지 못했습니다." : "Failed to generate summary.");

  // 캐시 저장 (Issue.summary)
  await prisma.issue.update({
    where: { id: issueId },
    data: { summary }, // updatedAt 은 @updatedAt 으로 자동 갱신됨
  });

  return { summary, cached: false };
}
