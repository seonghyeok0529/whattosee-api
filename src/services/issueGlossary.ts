// src/services/issueGlossary.ts
import { prisma } from "../lib/prisma";
import {
  generateGlossaryText,
} from "./generateGlossary"; // ✅ 새 유틸

/**
 * 이슈 기반 용어 사전 텍스트 재생성
 * - 반환값은 { glossaryText: string | null } 형식으로 유지
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

  // DB에 저장
  await prisma.issue.update({
    where: { id: issueId },
    data: {
      // @ts-ignore: 스키마에 glossaryText 필드 있다고 가정
      glossaryText,
    },
  });

  return { glossaryText };
}
