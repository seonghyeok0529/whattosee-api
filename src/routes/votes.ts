// src/routes/votes.ts
import { Router } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth } from "../middleware/requireAuth";
import jwt from "jsonwebtoken";
import type { Prisma } from "@prisma/client";

// ── helper: enum parser (문자열 → 리터럴 유니온으로 좁히기)
type ParentTypeT = 'issue' | 'agenda' | 'clipIssue';
type StanceT = 'agree' | 'neutral' | 'disagree';

const parseParentType = (v: unknown): ParentTypeT | null =>
  v === 'issue' || v === 'agenda' || v === 'clipIssue' ? v : null;

const parseStance = (v: unknown): StanceT | null =>
  v === 'agree' || v === 'neutral' || v === 'disagree' ? v : null;

const router = Router();

/** POST /api/votes  (로그인 필수) */
router.post("/", requireAuth as any, async (req: any, res) => {
    const pt = parseParentType(req.body?.parentType);
    const parentId = String(req.body?.parentId ?? "");
    const st = parseStance(req.body?.stance);
    const userId = req.userId as string | undefined;
  
    if (!pt || !parentId || !st) {
      return res.status(400).json({ error: "BAD_REQUEST" });
    }
    if (!userId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
  
    try {
      // 기존 표 삭제(사용자 기준으로 1표 유지)
      await prisma.vote.deleteMany({ where: { parentType: pt, parentId, userId } });
  
      const created = await prisma.vote.create({
        data: { parentType: pt, parentId, stance: st, userId },
        select: { id: true },
      });
  
      return res.json({ ok: true, voteId: created.id });
    } catch (e: any) {
      console.error("[votes] post error:", e);
      return res.status(500).json({ error: "VOTE_ERROR" });
    }
  });

/** GET /api/votes/results?parentType=issue&parentId=xxx&cti=EIP */
router.get("/results", async (req, res) => {
    const pt = parseParentType(req.query.parentType);
    const parentId = typeof req.query.parentId === 'string' ? req.query.parentId : "";
    const cti = typeof req.query.cti === 'string' ? req.query.cti : undefined;
  
    if (!pt || !parentId) {
      return res.status(400).json({ error: "BAD_REQUEST" });
    }

  const where: Prisma.VoteWhereInput = {
    parentType: pt,    // ✅ string → 리터럴 유니온으로 좁혀서 OK
    parentId,
    ...(cti ? { ctiType: cti } : {}),
  };

  const rows = await prisma.vote.groupBy({
    by: ["stance"],
    where,
    _count: { _all: true },
  });

  const counts = { agree: 0, neutral: 0, disagree: 0 };
  for (const r of rows) counts[r.stance as "agree"|"neutral"|"disagree"] = r._count._all;

  const total = counts.agree + counts.neutral + counts.disagree;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

  res.json({
    agree: counts.agree,
    neutral: counts.neutral,
    disagree: counts.disagree,
    total,
    agreePercent: pct(counts.agree),
    neutralPercent: pct(counts.neutral),
    disagreePercent: pct(counts.disagree),
  });
});

/** GET /api/votes/my?parentType=issue|agenda&parentId=xxx  */
router.get("/my", requireAuth as any, async (req: any, res) => {
    const pt = parseParentType(req.query.parentType);
    const parentId = typeof req.query.parentId === 'string' ? req.query.parentId : "";
    const userId = req.userId as string | undefined;
  
    if (!pt || !parentId) return res.status(400).json({ error: "BAD_REQUEST" });
    if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });
  
    const mine = await prisma.vote.findFirst({
      where: { parentType: pt, parentId, userId },
      select: { stance: true },
    });
  
    return res.json({ stance: (mine?.stance ?? null) as StanceT | null });
  });

export default router;
