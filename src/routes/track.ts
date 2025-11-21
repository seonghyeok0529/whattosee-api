// src/routes/track.ts
import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient, ParentType, SourceSide } from "@prisma/client";
import crypto from "crypto";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();
const router = Router();

/**
 * ✅ JWT 시크릿: requireAuth / signAccess 와 반드시 동일하게 맞춘다
 *  - 우선 JWT_ACCESS_SECRET 사용
 *  - 없으면 JWT_SECRET, 그래도 없으면 dev-secret
 */
const ACCESS_TOKEN_SECRET =
  process.env.JWT_ACCESS_SECRET ||
  process.env.JWT_SECRET ||
  "dev-secret";

// YYYY-MM-DD
function toDayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// (선택) IP 해시
function ipHash(req: Request) {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "";
  return ip ? crypto.createHash("sha256").update(ip).digest("hex") : undefined;
}

// 'issue'/'agenda' or 'ISSUE'/'AGENDA' → Prisma enum
function coerceParentTypeEnum(input: string): ParentType | null {
  if (!input) return null;
  const k1 = input as keyof typeof ParentType;
  const k2 = input.toUpperCase() as keyof typeof ParentType;
  return (ParentType as any)[k1] ?? (ParentType as any)[k2] ?? null;
}

/**
 * Authorization 헤더에서 userId 추출 (optional auth)
 * - 다른 미들웨어에서 userId 넣어줬으면 그걸 우선 사용
 * - 없으면 Bearer 토큰을 직접 decode해서 userId / sub 사용
 */
function getUserIdFromReq(req: Request): string | null {
  // 1) 미들웨어에서 이미 실어준 경우
  const existing = (req as any).userId;
  if (existing) return existing as string;

  // 2) Authorization: Bearer <token> 직접 파싱
  const auth =
    (req.headers.authorization as string | undefined) ||
    ((req.headers as any).Authorization as string | undefined);

  if (!auth || !auth.startsWith("Bearer ")) return null;

  const token = auth.slice(7);

  try {
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET) as any;
    return decoded.userId || decoded.sub || null;
  } catch (err) {
    // 디버깅 필요하면 잠깐 열기
    // console.warn("[track] token decode failed:", (err as any)?.message);
    return null;
  }
}

/**
 * POST /api/track/view
 * body: { parentType: 'issue'|'agenda'|'clipIssue', parentId: string }
 * auth 불필수(익명 허용)
 *
 * 👉 우리 서비스 내부 페이지뷰(이슈 상세/뉴스클립이슈 상세)용
 */
router.post("/track/view", async (req: Request, res: Response) => {
  try {
    const { parentType, parentId } = req.body || {};
    if (!parentType || !parentId) {
      return res.status(400).json({ ok: false, error: "INVALID_BODY" });
    }

    const ptEnum = coerceParentTypeEnum(String(parentType));
    if (!ptEnum) {
      return res.status(400).json({ ok: false, error: "INVALID_PARENT_TYPE" });
    }

    const dayKey = toDayKey();

    // ensureSession가 심어준 sid (없을 경우 대비)
    const cookieSid =
      (req as any).sessionId ||
      (req as any).sid ||
      (req as any).cookies?.sid ||
      "";

    // 쿠키가 비어도 하루 중복 방지키 용으로 안정적인 fallback
    const fallbackSid =
      cookieSid ||
      `anon:${crypto
        .createHash("sha256")
        .update(
          [
            req.headers["user-agent"] || "",
            req.headers["x-forwarded-for"] || req.socket.remoteAddress || "",
            dayKey,
            String(parentType),
            String(parentId),
          ].join("|")
        )
        .digest("hex")
        .slice(0, 32)}`;

    const userId = getUserIdFromReq(req);

    // ✅ 하루/세션별 1회만
    await prisma.pageView.upsert({
      where: {
        parentType_parentId_sessionId_dayKey: {
          parentType: ptEnum,
          parentId: String(parentId),
          sessionId: fallbackSid,
          dayKey,
        },
      },
      update: {}, // 이미 있으면 아무것도 안 함
      create: {
        parentType: ptEnum,
        parentId: String(parentId),
        sessionId: fallbackSid,
        userId,
        dayKey,
        ipHash: ipHash(req),
        userAgent: req.headers["user-agent"],
      },
    });

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[track/view] error", {
      code: e?.code,
      message: e?.message,
      meta: e?.meta,
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/**
 * 🔥 기사 클릭 로그 (진보/보수 기사 링크)
 * POST /api/track/article-view
 * body: { sourceId: string, side: 'left'|'center'|'right'|'neutral' }
 *
 * - 우리 서비스 외부(언론사 사이트)의 페이지는 PageView로 잡을 수 없어서
 *   "클릭 1회"를 ArticleViewLog로만 쌓는다.
 * - 중복 방지: userId + sourceId 기준으로 한 번만 기록
 */
router.post("/track/article-view", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromReq(req);

    // 익명 유저는 통계/프로필에 쓸 수 없으니 그냥 스킵 (성공 응답만)
    if (!userId) {
      return res.json({ ok: true, skipped: "ANON" });
    }

    // ⬇️ side 는 이제 안 받거나, 받아도 무시
    const { sourceId } = (req.body ?? {}) as {
      sourceId?: string;
      side?: SourceSide | string; // 있어도 사용 안 함
    };

    if (!sourceId) {
      return res.status(400).json({ ok: false, error: "INVALID_BODY" });
    }

    // 🔍 DB에서 source 찾아서 side 가져오기
    const src = await prisma.source.findUnique({
      where: { id: sourceId },
      select: { side: true },
    });

    if (!src) {
      return res.status(404).json({ ok: false, error: "SOURCE_NOT_FOUND" });
    }

    const side = src.side; // 'left' | 'center' | 'right' | 'neutral'

    // 이미 로그가 있으면 생성 안 함 → "중복 없이"
    const existing = await prisma.articleViewLog.findFirst({
      where: { userId, sourceId },
      select: { id: true },
    });

    if (!existing) {
      await prisma.articleViewLog.create({
        data: {
          userId,
          sourceId,
          side, // 🔥 여기서 DB에 있는 side 사용
        },
      });
    }

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[track/article-view] error", {
      code: e?.code,
      message: e?.message,
      meta: e?.meta,
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});


/**
 * 🔥 뉴스 클립 클릭/재생 로그
 * POST /api/track/news-clip-view
 * body: {
 *   clipIssueId?: string;
 *   rawClipId?: string;      // RawClip.id
 *   group: 'progressive' | 'public' | 'conservative';
 * }
 *
 * - 외부(유튜브) 페이지뷰 대신 "클립 1개를 본 적 있다"라는 로그만 저장
 * - 중복 방지: userId + (rawClipId || clipIssueId) + group 조합 기준 1회
 */
router.post("/track/news-clip-view", async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromReq(req);

    // 익명은 스킵
    if (!userId) {
      return res.json({ ok: true, skipped: "ANON" });
    }

    const { clipIssueId, rawClipId, group } = (req.body ?? {}) as {
      clipIssueId?: string;
      rawClipId?: string;
      group?: string;
    };

    if (!group || (!clipIssueId && !rawClipId)) {
      return res.status(400).json({ ok: false, error: "INVALID_BODY" });
    }

    const validGroups = ["progressive", "public", "conservative"] as const;
    if (!validGroups.includes(group as any)) {
      return res.status(400).json({ ok: false, error: "INVALID_GROUP" });
    }

    const existing = await prisma.newsClipViewLog.findFirst({
      where: {
        userId,
        group,
        OR: [
          rawClipId ? { rawClipId } : { rawClipId: null },
          clipIssueId ? { clipIssueId } : { clipIssueId: null },
        ],
      },
      select: { id: true },
    });

    if (!existing) {
      await prisma.newsClipViewLog.create({
        data: {
          userId,
          group,
          rawClipId: rawClipId ?? null,
          clipIssueId: clipIssueId ?? null,
        },
      });
    }

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[track/news-clip-view] error", {
      code: e?.code,
      message: e?.message,
      meta: e?.meta,
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

export default router;
