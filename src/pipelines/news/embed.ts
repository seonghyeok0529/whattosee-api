// src/pipelines/news/embed.ts
import prisma from "../../lib/prisma.js";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.UPSTAGE_API_KEY,
  baseURL: "https://api.upstage.ai/v1",
});

export async function embedArticles(limit = 30) {
  const items = await prisma.rawArticle.findMany({
    where: { status: "PARSED" },
    take: limit,
    orderBy: { createdAt: "asc" },
    select: { id: true, text: true },
  });

  for (const a of items) {
    try {
      const r = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: a.text!.slice(0, 8000), // 토큰 컷
      });
      const vec = Float32Array.from(r.data[0].embedding);
      await prisma.rawArticle.update({
        where: { id: a.id },
        data: { embedding: Buffer.from(vec.buffer), status: "EMBEDDED" },
      });
    } catch {
      await prisma.rawArticle.update({ where: { id: a.id }, data: { status: "FAILED" }});
    }
  }
}
