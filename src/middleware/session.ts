import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";

const SID_COOKIE = "sid";

export function ensureSessionId(req: Request, res: Response, next: NextFunction) {
  let sid = req.cookies?.[SID_COOKIE];
  if (!sid) {
    sid = randomBytes(16).toString("hex");
    res.cookie(SID_COOKIE, sid, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }
  (req as any).sessionId = sid;
  next();
}
