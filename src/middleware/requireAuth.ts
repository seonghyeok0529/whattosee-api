// src/middleware/requireAuth.ts
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export type AuthedUser = {
  id: string;
  email: string | null;
  role: string | null;
  isAdmin?: boolean | null;
};

export type AuthedRequest = Request & {
  userId?: string;
  user?: AuthedUser;
};

interface JWTPayload {
  sub: string;        // userId
  email?: string | null;
}

/**
 * Authorization: Bearer <accessToken> 만 사용
 * (refresh cookie(rt)는 여기서 쓰지 않는다)
 */
export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const header = (req.headers.authorization ?? (req.headers as any).Authorization) as
      | string
      | undefined;

    const bearer =
      header && header.startsWith("Bearer ") ? header.slice(7) : undefined;

    const token = bearer;
    if (!token) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    // 1) JWT 검증
    const payload = jwt.verify(
      token,
      process.env.JWT_ACCESS_SECRET!
    ) as JWTPayload;

    if (!payload?.sub) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    // 2) DB에서 유저 조회 (role, isAdmin 포함)
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        isAdmin: true, // 🔥 이 필드가 adminAuth에서 필요
      },
    });

    if (!user) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    // 3) req에 실어두기
    req.userId = user.id;
    (req as any).user = user as AuthedUser;

    return next();
  } catch (err) {
    console.error("[requireAuth] error:", (err as any)?.message);
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
}
