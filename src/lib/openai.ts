// src/lib/openai.ts
import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.UPSTAGE_API_KEY, // .env 에 UPSTAGE_API_KEY 넣기
  baseURL: "https://api.upstage.ai/v1",
});

// 모델은 비용/속도 균형으로 소형 사용, 필요시 변경
export const DEFAULT_MODEL = "solar-pro3";
