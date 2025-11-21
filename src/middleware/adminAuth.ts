// src/middleware/adminAuth.ts
import type { Response, NextFunction } from "express";
import type { AuthedRequest } from "./requireAuth";

export function adminAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const allowList = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const email = user.email?.toLowerCase() ?? null;

  const isAdminRole = user.role === "admin";
  const isAdminFlag = !!user.isAdmin;
  const isAllowListed = !!(email && allowList.includes(email));

  if (!isAdminRole && !isAdminFlag && !isAllowListed) {
    // 권한 없음
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  return next();
}
