// src/services/generateGlossary.ts
import { openai, DEFAULT_MODEL } from "../lib/openai.js";

export type GlossaryLocale = "ko" | "en"; 
export type GlossarySourceType = "article" | "clip";

export interface GenerateGlossaryParams {
  title?: string | null;
  summary?: string | null;
  itemsText: string;          // "- [출처] 제목" / "- [채널] 제목" 목록 문자열
  locale?: GlossaryLocale;
  sourceType?: GlossarySourceType;
}

/**
 * 공통 Glossary 생성기
 * - Issue / ClipIssue 둘 다에서 재사용
 */
export async function generateGlossaryText({
  title,
  summary,
  itemsText,
  locale = "ko",
  sourceType = "article",
}: GenerateGlossaryParams): Promise<string | null> {
  const safeTitle = title?.trim() || "(제목 없음)";
  const safeSummary = summary?.trim() || "(요약 없음)";
  const safeItems = itemsText?.trim() || "(목록 없음)";

  const typeLabel =
    sourceType === "clip" ? "유튜브 뉴스 클립" : "온라인 뉴스 기사";

  const userPromptKo = `
당신은 한국의 정치/사회 ${typeLabel} 이슈를 설명하는 "용어 사전" 편집자입니다.

다음 이슈 제목과 요약, 관련 ${typeLabel} 목록을 보고
일반인이 이해하기 쉽게 관련 핵심 용어들을 뽑아서
"용어: 설명" 형식으로 정리해 주세요.

요구사항:
1) 난이도는 시사 뉴스에 관심 있는 일반 성인 기준
2) 너무 사소한 고유명사는 제외하고, 쟁점을 이해하는 데 필요한 핵심 개념 위주
3) 가능한 한 5~15개 정도의 용어를 제시
4) 각 설명은 1~3문장 이내로 간결하게
5) 정치적·이념적 표현은 중립적으로, 사실 위주로 작성

이슈 제목: ${safeTitle}
이슈 요약: ${safeSummary}

관련 ${typeLabel} 목록:
${safeItems}
`.trim();

  const userPromptEn = `
You are an editor of a glossary explaining political/social issues.

Given the issue title, summary and related ${typeLabel} list,
extract key terms and define them in a "Term: Definition" format,
in clear language for general readers.

Requirements:
1) Focus on core concepts needed to understand the controversy.
2) 5–15 terms if possible.
3) Each definition within 1–3 sentences.
4) Keep the tone neutral and factual.

Issue title: ${safeTitle}
Issue summary: ${safeSummary}

Related ${typeLabel} list:
${safeItems}
`.trim();

  const prompt = locale === "ko" ? userPromptKo : userPromptEn;

  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          locale === "ko"
            ? "너는 정치·사회 이슈를 중립적으로 설명하는 용어 사전 편집자다. '용어: 설명' 형식을 지켜라."
            : "You are a neutral glossary editor for political/social issues. Always answer in 'Term: Definition' lines.",
      },
      { role: "user", content: prompt },
    ],
  });

  const text = completion.choices?.[0]?.message?.content?.trim() || "";
  return text.length ? text : null;
}
