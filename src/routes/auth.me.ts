import { Router } from "express";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma.js";

const router = Router();

// GET /api/auth/me
router.get("/me", async (req, res) => {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as { sub: string };
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true, email: true, username: true, createdAt: true, nickname: true,
        role: true, isAdmin: true,
      },
    });
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    return res.json({ user });
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
});

export default router;
