import { OpenAI } from "openai";
import type { Issue, Source } from "@prisma/client";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generateIssueTitle(issue: Issue & { sources: Source[] }) {
  // 기사 제목 모음
  const titles = issue.sources
    .map((s) => s.title?.trim())
    .filter(Boolean)
    .slice(0, 8) // 최대 8개까지만
    .join("\n");

  const prompt = `
다음은 여러 언론사 기사 제목들이다.
공통된 이슈를 가장 간결하게 요약하는 "이슈 제목"을 만들어라.

조건:
- 15자 이내
- 핵심 내용만 압축
- 정보 중복 금지
- 과장·자극적 표현 금지
- 언론이 실제로 쓸 법한 어법 사용
- 신뢰성 있는 표현
- ‘핵심 사건/논점’이 제목에 반드시 포함될 것

기사 제목들:
${titles}

이슈 제목:
`.trim();

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "너는 한국 뉴스 이슈 제목을 요약하는 전문가다.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 50,
  });

  return res.choices[0]?.message?.content?.trim() ?? "";
}
