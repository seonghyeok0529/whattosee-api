// src/routes/cti.ts
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import prisma from "../lib/prisma.js";

export const ctiRouter = Router();

/**
 * POST /api/cti/submit
 * body: { ctiType: string; scores: any }
 * 저장: User.ctiType, User.ctiScores
 */
ctiRouter.post("/submit", requireAuth as any, async (req: any, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: "UNAUTHORIZED" });
    const { ctiType, scores } = req.body ?? {};

    if (typeof ctiType !== "string" || !ctiType.trim()) {
      return res.status(400).json({ error: "INVALID_CTI" });
    }

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { ctiType: ctiType.trim().toUpperCase(), ctiScores: scores ?? undefined },
      select: { id: true, email: true, username: true, ctiType: true, ctiScores: true },
    });

    return res.json({ ok: true, user });
  } catch (e) {
    console.error("[CTI submit] error:", e);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

/**
 * GET /api/cti/result
 * 현재 로그인 사용자의 저장된 CTI 반환
 */
ctiRouter.get("/result", requireAuth as any, async (req: any, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: "UNAUTHORIZED" });
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { ctiType: true, ctiScores: true, updatedAt: true },
    });
    if (!user?.ctiType) return res.status(404).json({ error: "NO_CTI" });
    return res.json({
      ctiType: user.ctiType,
      scores: user.ctiScores ?? null,
      createdAt: user.updatedAt.toISOString(),
    });
  } catch (e) {
    console.error("[CTI result] error:", e);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

export default ctiRouter;
