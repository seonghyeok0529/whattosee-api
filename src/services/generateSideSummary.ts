import { prisma } from "../lib/prisma";
import OpenAI from "openai";

const openai = new OpenAI();

export async function generateSideSummary(issueId: string, side: "left" | "right") {
  const sources = await prisma.source.findMany({
    where: { issueId, side },
    select: { url: true }
  });

  const urls = sources.map(s => s.url).filter(Boolean);

  const articles = await prisma.rawArticle.findMany({
    where: { url: { in: urls } },
    select: {
      title: true,
      outlet: true,
      url: true,
      text: true
    }
  });

  if (articles.length === 0) {
    return "";
  }

  const prompt = `
다음 기사들은 모두 "${side === "left" ? "진보" : "보수"} 성향 언론"의 보도들입니다.
이 기사들이 공통으로 주장하거나 강조하는 핵심 요지를 요약하세요.

요약 방식:
- 2~3문장 핵심 정리
- 언론 논조와 주장 중심
- 객관적인 표현 유지

출력 형식:
`;

  const content = articles.map((a,i)=>`[${i+1}] (${a.outlet}) ${a.title}\n${a.text?.slice(0,1200)}`).join("\n\n");

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role:"system", content:"You are an expert news sentiment analyzer." },
      { role:"user", content: prompt + "\n\n" + content }
    ],
    temperature: 0.3
  });

  return r.choices[0].message.content?.trim() ?? "";
}