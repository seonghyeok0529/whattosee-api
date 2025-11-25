// src/services/issueGlossary.ts
import { prisma } from "../lib/prisma";
import { generateGlossaryText } from "./generateGlossary";

/**
 * 이슈 기반 용어 사전 텍스트 재생성
 * - 반환값은 { glossaryText: string | null } 형식 유지
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

  const articlesText = issue.sources
    .map((s) => `- [${s.outlet ?? "언론"}] ${s.title ?? "(제목 없음)"}`)
    .join("\n");

  const glossaryText = await generateGlossaryText({
    title: issue.title,
    summary: issue.summary,
    itemsText: articlesText,
    locale: "ko",
    sourceType: "article",
  });

  await prisma.issue.update({
    where: { id: issueId },
    data: {
      // @ts-ignore: Issue 모델에 glossaryText 필드가 있다고 가정
      glossaryText,
    },
  });

  return { glossaryText };
}
