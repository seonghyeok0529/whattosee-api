// src/routes/irt.ts
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import prisma from "../lib/prisma.js";

export const irtRouter = Router();

/**
 * POST /api/irt/submit
 * body: { irtType: string; scores: any; answers?: any; meta?: any }
 * 저장: User.irtType, User.irtScores
 *
 * - answers/meta는 일단 저장하지 않고(로그용) 필요하면 테이블 만들어서 확장
 */
irtRouter.post("/submit", requireAuth as any, async (req: any, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: "UNAUTHORIZED" });

    const { irtType, scores } = req.body ?? {};

    if (typeof irtType !== "string" || !irtType.trim()) {
      return res.status(400).json({ error: "INVALID_IRT" });
    }

    // scores는 Json 컬럼으로 그대로 저장 (형식 검증은 최소)
    if (scores == null || typeof scores !== "object") {
      return res.status(400).json({ error: "INVALID_SCORES" });
    }

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        irtType: irtType.trim().toUpperCase(),
        irtScores: scores ?? undefined,
      },
      select: {
        id: true,
        email: true,
        username: true,
        irtType: true,
        irtScores: true,
      },
    });

    return res.json({ ok: true, user });
  } catch (e) {
    console.error("[IRT submit] error:", e);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/irt/result
 * 현재 로그인 사용자의 저장된 IRT 반환
 */
irtRouter.get("/result", requireAuth as any, async (req: any, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: "UNAUTHORIZED" });

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { irtType: true, irtScores: true, updatedAt: true },
    });

    if (!user?.irtType) return res.status(404).json({ error: "NO_IRT" });

    return res.json({
      irtType: user.irtType,
      scores: user.irtScores ?? null,
      createdAt: user.updatedAt.toISOString(),
    });
  } catch (e) {
    console.error("[IRT result] error:", e);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

export default irtRouter;
