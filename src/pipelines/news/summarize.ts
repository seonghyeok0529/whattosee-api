// src/pipelines/news/summarize.ts
import OpenAI from "openai";

const openai = new OpenAI();

export async function summarizeCluster(docs: {title:string; outlet:string; url:string; text:string}[]) {
  const prompt = `당신은 전문 뉴스 분석가입니다.

  지금부터 여러 언론 기사 내용을 제공합니다.
  이 내용만 요약하지 말고, 먼저 이 사건이 무엇인지 외부 지식을 포함해 설명한 뒤,
  해당 기사의 핵심 내용을 분석적으로 정리하십시오.
  
  요구사항:
  
  1. 먼저 해당 사건 또는 이슈에 대해 간단히 설명
     - 사건/논쟁/정책의 배경
     - 핵심 인물 또는 기관
     - 한국/세계의 맥락 안에서 어떤 의미인지
  
  2. 그 다음 언론 기사들의 내용을 요약하되, 다음 기준을 지킵니다:
     - 언론사가 전하는 주장/팩트/입장 구분
     - 이슈 진행 상황 (시간적 흐름 포함)
     - 논쟁 구조 또는 갈등 지점
     - 향후 전망 또는 남은 쟁점
  
  3. 문체는 중립적, 객관적, 사설 없이
  
  4. 한국 독자를 기준으로 작성
  
  5. 2~3 문장 이내로 정리
  
  출력 형식:
  
  [사건 개요]
  (사건 설명 1-2문장)
  
  [언론 요약]
  (기사 핵심 요약 1-2문장)
  
  [쟁점 및 전망]
  (갈등 지점 또는 앞으로의 가능성 1문장)

  모바일 환경에서 읽기 쉽게 가독성 좋게 작성
  한 문장 마칠 때마다 줄 바꿈

출력은 JSON:
{"title":"","summary":"","tags":[],"persons":[]}

기사들:
${docs.map((d,i)=>`[${i+1}] (${d.outlet}) ${d.title}\nURL: ${d.url}\n본문:\n${d.text.slice(0,1500)}...`).join("\n\n")}
`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role:"user", content: prompt }],
    temperature: 0.2,
    response_format: { type: "json_object" as any },
  });

  const j = JSON.parse(r.choices[0].message.content||"{}");
  return {
    title: j.title || "이슈",
    summary: j.summary || "",
    tags: Array.isArray(j.tags) ? j.tags : [],
    persons: Array.isArray(j.persons) ? j.persons : [],
  };
}
