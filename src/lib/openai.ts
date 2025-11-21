// src/lib/openai.ts
import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // .env 에 OPENAI_API_KEY 넣기
});

// 모델은 비용/속도 균형으로 소형 사용, 필요시 'gpt-4o'로 변경
export const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
