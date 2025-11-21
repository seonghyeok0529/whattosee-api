import { Router } from "express";
import prisma from "../lib/prisma.js";
import jwt from "jsonwebtoken";

const router = Router();

function getUserId(req: any): string | null {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_ACCESS_SECRET!
    ) as { sub?: string };
    return payload?.sub ?? null;
  } catch {
    return null;
  }
}

/** 내부 공통 매핑 함수: nickname → username → '익명' */
function mapIssueComment(c: any) {
  const nickname = c.user?.nickname ?? null;
  const username = c.user?.username ?? null;

  return {
    id: c.id,
    content: c.content,
    createdAt: c.createdAt,
    likes: c.likes,
    authorId: c.user?.id ?? null,
    authorName: nickname || username || "익명",
    user: c.user
      ? {
          id: c.user.id,
          username: c.user.username,
          nickname: c.user.nickname ?? null,
        }
      : null,
  };
}

/** GET /api/issues/:id/comments */
router.get("/:id/comments", async (req, res) => {
  const issueId = req.params.id;

  const rows = await prisma.issueComment.findMany({
    where: { issueId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      content: true,
      createdAt: true,
      likes: true,
      user: {
        select: {
          id: true,
          username: true,
          nickname: true, // 🔥 닉네임 추가
        },
      },
    },
  });

  const items = rows.map(mapIssueComment);
  res.json({ items });
});

/** POST /api/issues/:id/comments { content } */
router.post("/:id/comments", async (req, res) => {
  const issueId = req.params.id;
  const content = String(req.body?.content ?? "").trim();
  if (!content) {
    return res.status(400).json({ error: "CONTENT_REQUIRED" });
  }

  const userId = getUserId(req); // 없어도 저장(익명)

  const c = await prisma.issueComment.create({
    data: { issueId, content, userId: userId ?? null },
    select: {
      id: true,
      content: true,
      createdAt: true,
      likes: true,
      user: {
        select: {
          id: true,
          username: true,
          nickname: true, // 🔥 닉네임 추가
        },
      },
    },
  });

  const comment = mapIssueComment(c);
  res.status(201).json({ comment });
});

export default router;
