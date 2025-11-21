// src/middleware/ensureSession.ts
import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export function ensureSession(req: Request, res: Response, next: NextFunction) {
  // cookie-parser가 있으니 req.cookies에서 읽힘
  let sid = (req as any).cookies?.sid as string | undefined;

  if (!sid) {
    sid = crypto.randomBytes(16).toString("hex");
    const isProd = process.env.NODE_ENV === "production";
    res.cookie("sid", sid, {
      httpOnly: true,
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1y
      sameSite: "lax",                   // dev 프록시 환경에 안전
      secure: isProd ? true : false,     // http 로컬에서는 false
    });
  }

  // 라우터에서 편하게 쓰도록 컨텍스트에 넣어줌
  (req as any).sid = sid;
  (req as any).sessionId = sid;
  next();
}
