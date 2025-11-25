// src/services/issueGlossary.ts
import { prisma } from "../lib/prisma";
import { OpenAI } from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * 이슈 기반 용어 사전 텍스트 재생성
 * - 반환값은 { glossaryText: string | null } 형식으로 맞춰둠
 */
export async function refreshIssueGlossary(issueId: string) {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    include: {
      sources: {
        select: {
          url: true,
          outlet: true,
          title: true,
        },
      },
    },
  });

  if (!issue) return null;

  // 🔹 간단 예시: 이슈 제목/요약 + 기사 리스트를 기반으로 glossaryText 만들어보기
  const articlesText = issue.sources
    .map((s) => `- [${s.outlet}] ${s.title}`)
    .join("\n");

  const prompt = `
당신은 정치/사회 이슈를 설명하는 용어 사전 편집자입니다.

다음 이슈 제목과 요약, 관련 기사 목록을 보고
일반인이 이해하기 쉽게 관련 핵심 용어들을 뽑아서
"용어: 설명" 형식으로 정리해 주세요.

이슈 제목: ${issue.title ?? "(제목 없음)"}
이슈 요약: ${issue.summary ?? "(요약 없음)"}

관련 기사 목록:
${articlesText || "(기사 없음)"}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });

  const glossaryText =
    completion.choices[0]?.message?.content?.trim() || null;

  // 🔹 Issue 테이블에 glossaryText 같은 필드가 있으면 여기에 저장
  // (스키마에 따라 수정)
  await prisma.issue.update({
    where: { id: issueId },
    data: {
      // @ts-ignore: 스키마에 glossaryText 필드 있다고 가정
      glossaryText,
    },
  });

  return { glossaryText };
}
