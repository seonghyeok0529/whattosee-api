// src/routes/profile.ts
import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";

const prisma = new PrismaClient();
const router = Router();

/**
 * 내 프로필 조회
 * GET /api/profile
 */
router.get("/", requireAuth as any, async (req, res) => {
  const userId = (req as any).userId as string | undefined;
  if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      username: true,
      nickname: true,
      bio: true,
      interests: true,
      ctiType: true,
      ctiScores: true,

      // ✅ IRT 추가
      irtType: true,
      irtScores: true,

      createdAt: true,
      role: true,
      isAdmin: true,

      // 🔥 온보딩/약관 관련 필드
      tosAgreedAt: true,
      privacyAgreedAt: true,
      marketingAgreed: true,
    },
  });

  if (!user) return res.status(404).json({ error: "NOT_FOUND" });

  const allowList = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const isAdmin =
    user.role === "admin" ||
    (user.email ? allowList.includes(user.email.toLowerCase()) : false) ||
    user.isAdmin === true;

  return res.json({
    user: {
      ...user,
      isAdmin,
      // 프론트에서 쓰기 좋은 alias
      marketingOptIn: user.marketingAgreed ?? false,
    },
  });
});

/**
 * 내 프로필 업데이트(온보딩 포함)
 * PATCH /api/profile
 *
 * ✅ 추가 지원 필드:
 * - ctiType: string | null
 * - ctiScores: Json | null
 * - irtType: string | null
 * - irtScores: Json | null
 */
router.patch("/", requireAuth as any, async (req, res) => {
  const userId = (req as any).userId as string | undefined;
  if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

  const {
    username,
    nickname,
    bio,
    interests,
    tosAgreedAt,
    privacyAgreedAt,
    marketingOptIn,

    // ✅ CTI 추가
    ctiType,
    ctiScores,

    // ✅ IRT 추가
    irtType,
    irtScores,
  } = (req.body ?? {}) as {
    username?: string;
    nickname?: string;
    bio?: string;
    interests?: string[] | null;
    tosAgreedAt?: string | boolean;
    privacyAgreedAt?: string | boolean;
    marketingOptIn?: boolean;

    ctiType?: string | null;
    ctiScores?: unknown | null; // Prisma Json 호환

    irtType?: string | null;
    irtScores?: unknown | null; // Prisma Json 호환
  };

  const data: any = {};

  if (typeof nickname === "string") {
    data.nickname = nickname.trim() || null;
  }

  if (typeof username === "string") {
    data.username = username;
  }

  if (typeof bio === "string") data.bio = bio;

  if (Array.isArray(interests)) data.interests = interests as any;

  // ✅ CTI 저장
  if (typeof ctiType === "string") {
    data.ctiType = ctiType.trim() || null;
  } else if (ctiType === null) {
    data.ctiType = null;
  }

  // ctiScores는 object/array/number/string 등 Json 가능
  // - undefined: 업데이트 안 함
  // - null: null로 초기화
  if (typeof ctiScores !== "undefined") {
    data.ctiScores = ctiScores as any;
  }

  // ✅ IRT 저장
  if (typeof irtType === "string") {
    data.irtType = irtType.trim() || null;
  } else if (irtType === null) {
    data.irtType = null;
  }

  // irtScores는 object/array/number/string 등 Json 가능
  // - undefined: 업데이트 안 함
  // - null: null로 초기화
  if (typeof irtScores !== "undefined") {
    data.irtScores = irtScores as any;
  }

  // 🔥 약관 동의 시간 저장
  if (tosAgreedAt) {
    data.tosAgreedAt =
      typeof tosAgreedAt === "string" ? new Date(tosAgreedAt) : new Date();
  }
  if (privacyAgreedAt) {
    data.privacyAgreedAt =
      typeof privacyAgreedAt === "string" ? new Date(privacyAgreedAt) : new Date();
  }

  // 마케팅 수신 동의
  if (typeof marketingOptIn === "boolean") {
    data.marketingAgreed = marketingOptIn;
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      email: true,
      username: true,
      nickname: true,
      bio: true,
      interests: true,
      ctiType: true,
      ctiScores: true,

      // ✅ IRT 추가
      irtType: true,
      irtScores: true,

      createdAt: true,
      role: true,
      isAdmin: true,

      // 🔥 동일하게 포함
      tosAgreedAt: true,
      privacyAgreedAt: true,
      marketingAgreed: true,
    },
  });

  const allowList = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const isAdmin =
    updated.role === "admin" ||
    (updated.email ? allowList.includes(updated.email.toLowerCase()) : false) ||
    updated.isAdmin === true;

  return res.json({
    user: {
      ...updated,
      isAdmin,
      marketingOptIn: updated.marketingAgreed ?? false,
    },
  });
});

/**
 * 🔥 나의 기사/뉴스 클립 열람 비율
 * GET /api/profile/stats
 *
 * 반환 형식:
 * {
 *   articleViewRatio: { progressive, conservative, totalViews },
 *   clipViewRatio: { progressive, public, conservative, totalViews }
 * }
 */
router.get("/stats", requireAuth as any, async (req, res, next) => {
  try {
    const userId = (req as any).userId as string | undefined;
    if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

    /* ================================================
     * 1) 인터넷 기사 열람 비율 (진보 / 보수)
     *    → ArticleViewLog 기반
     * ================================================ */
    const articleLogs = await prisma.articleViewLog.findMany({
      where: { userId },
      select: { side: true },
    });

    const articleProgressiveCount = articleLogs.filter((l) => l.side === "left")
      .length;
    const articleConservativeCount = articleLogs.filter((l) => l.side === "right")
      .length;

    const articleTotal = articleProgressiveCount + articleConservativeCount;

    const articleViewRatio = {
      progressive: articleTotal
        ? Math.round((articleProgressiveCount / articleTotal) * 100)
        : 0,
      conservative: articleTotal
        ? Math.round((articleConservativeCount / articleTotal) * 100)
        : 0,
      totalViews: articleTotal,
    };

    /* ================================================
     * 2) 뉴스 클립 열람 비율 (진보 / 공영 / 보수)
     *    → NewsClipViewLog 기반
     * ================================================ */
    const clipLogs = await prisma.newsClipViewLog.findMany({
      where: { userId },
      select: { group: true },
    });

    const clipProgressiveCount = clipLogs.filter(
      (l) => l.group === "progressive"
    ).length;
    const clipPublicCount = clipLogs.filter((l) => l.group === "public").length;
    const clipConservativeCount = clipLogs.filter(
      (l) => l.group === "conservative"
    ).length;

    const clipTotal =
      clipProgressiveCount + clipPublicCount + clipConservativeCount;

    const clipViewRatio = {
      progressive: clipTotal
        ? Math.round((clipProgressiveCount / clipTotal) * 100)
        : 0,
      public: clipTotal ? Math.round((clipPublicCount / clipTotal) * 100) : 0,
      conservative: clipTotal
        ? Math.round((clipConservativeCount / clipTotal) * 100)
        : 0,
      totalViews: clipTotal,
    };

    return res.json({
      articleViewRatio,
      clipViewRatio,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 🔥 나의 활동 히스토리
 * GET /api/profile/history
 */
router.get("/history", requireAuth as any, async (req, res, next) => {
  try {
    const userId = (req as any).userId as string | undefined;
    if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

    // 이하 기존 코드 그대로
    const voteRows = await prisma.vote.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    const voteItems = await Promise.all(
      voteRows.map(async (v) => {
        let kind = "VOTE";
        let title = "(제목 없음)";
        let snippet: string | undefined;
        let parentType: "issue" | "agenda" | "clipIssue" = v.parentType as any;

        if (v.parentType === "issue") {
          const issue = await prisma.issue.findUnique({
            where: { id: v.parentId },
            select: { title: true },
          });
          title = issue?.title ?? title;
          kind = "ISSUE_VOTE";
        } else if (v.parentType === "clipIssue") {
          const clipIssue = await prisma.clipIssue.findUnique({
            where: { id: v.parentId },
            select: { title: true },
          });
          title = clipIssue?.title ?? title;
          kind = "CLIP_VOTE";
        } else if (v.parentType === "agenda") {
          const agenda = await prisma.agenda.findUnique({
            where: { id: v.parentId },
            select: { title: true, content: true },
          });
          title = agenda?.title ?? title;
          snippet = agenda?.content?.slice(0, 80);
          kind = "AGENDA_VOTE";
        }

        return {
          id: `vote_${v.id}`,
          kind,
          parentType,
          parentId: v.parentId,
          title,
          snippet,
          createdAt: v.createdAt.toISOString(),
        };
      })
    );

    const [agendaLikes, postLikes] = await Promise.all([
      prisma.agendaLike.findMany({
        where: { userId },
        include: {
          agenda: {
            select: { id: true, title: true, content: true, createdAt: true },
          },
        },
      }),
      prisma.communityPostLike.findMany({
        where: { userId },
        include: {
          post: {
            select: { id: true, title: true, content: true, createdAt: true },
          },
        },
      }),
    ]);

    const agendaLikeItems = agendaLikes.map((l) => ({
      id: `agendaLike_${l.userId}_${l.agendaId}`,
      kind: "AGENDA_LIKE" as const,
      parentType: "agenda" as const,
      parentId: l.agendaId,
      title: l.agenda?.title ?? "(제목 없음)",
      snippet: l.agenda?.content?.slice(0, 80),
      createdAt: l.createdAt.toISOString(),
    }));

    const postLikeItems = postLikes.map((l) => ({
      id: `postLike_${l.userId}_${l.postId}`,
      kind: "COMMUNITY_POST_LIKE" as const,
      parentType: "community" as const,
      parentId: l.postId,
      title: l.post?.title ?? "(제목 없음)",
      snippet: l.post?.content?.slice(0, 80),
      createdAt: l.createdAt.toISOString(),
    }));

    const [myAgendas, myPosts] = await Promise.all([
      prisma.agenda.findMany({
        where: { userId },
        select: { id: true, title: true, content: true, createdAt: true },
      }),
      prisma.communityPost.findMany({
        where: { userId },
        select: { id: true, title: true, content: true, createdAt: true },
      }),
    ]);

    const myAgendaItems = myAgendas.map((a) => ({
      id: `myAgenda_${a.id}`,
      kind: "AGENDA_AUTHOR" as const,
      parentType: "agenda" as const,
      parentId: a.id,
      title: a.title ?? "(제목 없음)",
      snippet: a.content?.slice(0, 80),
      createdAt: a.createdAt.toISOString(),
    }));

    const myPostItems = myPosts.map((p) => ({
      id: `myPost_${p.id}`,
      kind: "COMMUNITY_POST_AUTHOR" as const,
      parentType: "community" as const,
      parentId: p.id,
      title: p.title ?? "(제목 없음)",
      snippet: p.content?.slice(0, 80),
      createdAt: p.createdAt.toISOString(),
    }));

    const [issueComments, agendaComments, clipIssueComments, postComments] =
      await Promise.all([
        prisma.issueComment.findMany({
          where: { userId },
          include: {
            issue: { select: { id: true, title: true } },
          },
        }),
        prisma.agendaComment.findMany({
          where: { userId },
          include: {
            agenda: { select: { id: true, title: true } },
          },
        }),
        prisma.clipIssueComment.findMany({
          where: { userId },
          include: {
            clipIssue: { select: { id: true, title: true } },
          },
        }),
        prisma.communityPostComment.findMany({
          where: { userId },
          include: {
            post: { select: { id: true, title: true } },
          },
        }),
      ]);

    const issueCommentItems = issueComments.map((c) => ({
      id: `issueComment_${c.id}`,
      kind: "COMMENT_ISSUE" as const,
      parentType: "issue" as const,
      parentId: c.issueId,
      title: c.issue?.title ?? "(제목 없음)",
      snippet: c.content?.slice(0, 80),
      createdAt: c.createdAt.toISOString(),
    }));

    const agendaCommentItems = agendaComments.map((c) => ({
      id: `agendaComment_${c.id}`,
      kind: "COMMENT_AGENDA" as const,
      parentType: "agenda" as const,
      parentId: c.agendaId,
      title: c.agenda?.title ?? "(제목 없음)",
      snippet: c.content?.slice(0, 80),
      createdAt: c.createdAt.toISOString(),
    }));

    const clipIssueCommentItems = clipIssueComments.map((c) => ({
      id: `clipIssueComment_${c.id}`,
      kind: "COMMENT_CLIP_ISSUE" as const,
      parentType: "clipIssue" as const,
      parentId: c.clipIssueId,
      title: c.clipIssue?.title ?? "(제목 없음)",
      snippet: c.content?.slice(0, 80),
      createdAt: c.createdAt.toISOString(),
    }));

    const postCommentItems = postComments.map((c) => ({
      id: `postComment_${c.id}`,
      kind: "COMMENT_COMMUNITY" as const,
      parentType: "community" as const,
      parentId: c.postId,
      title: c.post?.title ?? "(제목 없음)",
      snippet: c.content?.slice(0, 80),
      createdAt: c.createdAt.toISOString(),
    }));

    const items = [
      ...voteItems,
      ...agendaLikeItems,
      ...postLikeItems,
      ...myAgendaItems,
      ...myPostItems,
      ...issueCommentItems,
      ...agendaCommentItems,
      ...clipIssueCommentItems,
      ...postCommentItems,
    ];

    items.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const limited = items.slice(0, 200);

    return res.json({ items: limited });
  } catch (err) {
    next(err);
  }
});

export default router;
