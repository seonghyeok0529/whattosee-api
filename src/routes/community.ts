// src/routes/community.ts
import { Router, Request, Response } from 'express';
import { CommunityLounge, LinkedIssueType } from '@prisma/client';
import prisma from '@/lib/prisma';
import { requireAuth } from '@/middleware/requireAuth';

const router = Router();

const LOUNGE_VALUES: CommunityLounge[] = [
  'popular',
  'politics',
  'society',
  'economy',
  'international',
  'tech',
  'culture',
  'daily',
  'humor',
];

function isCommunityLounge(v: string): v is CommunityLounge {
  return LOUNGE_VALUES.includes(v as CommunityLounge);
}

// 🔹 닉네임 / username 우선순위
function resolveAuthor(
  u?: { nickname?: string | null; username?: string | null } | null,
) {
  return (
    (u?.nickname && u.nickname.trim()) ||
    (u?.username && u.username.trim()) ||
    '익명'
  );
}

// 🔹 댓글(Reply) DTO 매퍼
function mapReply(c: any) {
  const isAnonymous = !!c.isAnonymous;

  return {
    id: c.id,
    author: isAnonymous ? '익명' : resolveAuthor(c.user),
    cti: isAnonymous ? null : c.user?.ctiType ?? null,
    content: c.content,
    likes: c.likes,
    createdAt:
      c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
  };
}

// 🔹 공통 헬퍼: Poll 응답 객체 만들기
function buildPollResponse(
  poll: any,
  userId?: string | null,
  sessionId?: string | null,
) {
  if (!poll) return null;

  const rawOptions = Array.isArray(poll.options) ? (poll.options as any[]) : [];
  const votes = poll.votes ?? [];
  const totalVotes = votes.length;

  const myVote =
    votes.find((v: any) => userId && v.userId === userId) ??
    votes.find((v: any) => !userId && sessionId && v.sessionId === sessionId);

  const options = rawOptions.map((opt: any) => {
    const optionId = String(opt.id ?? opt.value ?? opt.optionId);
    const label = String(opt.label ?? opt.text ?? '');
    const count = votes.filter((v: any) => v.optionId === optionId).length;
    const percentage = totalVotes ? Math.round((count / totalVotes) * 100) : 0;

    return {
      id: optionId,
      label,
      votes: count,
      percentage,
    };
  });

  return {
    question: poll.question as string,
    options,
    totalVotes,
    myChoiceId: myVote?.optionId ?? null,
    closed: !!poll.closedAt,
  };
}

/* -----------------------------------------
 * GET /api/community/posts
 *  ?lounge=popular|politics...
 *  ?sort=popular|latest
 *  ?cursor=...
 *  ?take=20
 * ----------------------------------------*/
router.get('/community/posts', async (req: Request, res: Response) => {
  try {
    const loungeParam = (req.query.lounge as string) || 'popular';
    const sortParam = (req.query.sort as string) || 'popular';
    const cursor = (req.query.cursor as string) || null;
    const takeParam = req.query.take as string | undefined;

    const lounge: CommunityLounge = isCommunityLounge(loungeParam)
      ? (loungeParam as CommunityLounge)
      : 'popular';

    const sort: 'popular' | 'latest' =
      sortParam === 'latest' ? 'latest' : 'popular';

    const take = Math.min(Number(takeParam ?? 20) || 20, 50);

    const baseWhere =
      lounge === 'popular'
        ? {} // 전체 인기
        : { lounge };

    const orderBy =
      sort === 'latest'
        ? [{ createdAt: 'desc' as const }]
        : [
            { likesCount: 'desc' as const },
            { commentCount: 'desc' as const },
            { createdAt: 'desc' as const },
          ];

    const posts = await prisma.communityPost.findMany({
      where: baseWhere,
      orderBy,
      take: take + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      include: {
        user: true,
      },
    });

    const hasMore = posts.length > take;
    const items = hasMore ? posts.slice(0, take) : posts;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    // 🔥 프론트에서 기대하는 CommunityPostSummary 형태로 매핑
    return res.json({
      items: items.map((p) => {
        const isAnonymous = !!p.isAnonymous;
        return {
          id: p.id,
          title: p.title,
          contentPreview: p.content.slice(0, 200),
          author: isAnonymous ? '익명' : resolveAuthor(p.user),
          authorCTI: isAnonymous ? null : p.user?.ctiType ?? null,
          likes: p.likesCount,
          comments: p.commentCount,
          views: p.viewsCount,
          createdAt: p.createdAt.toISOString(),
          lounge: p.lounge,
          isHot: p.isHot,
          thumbnail: p.thumbnail,
        };
      }),
      nextCursor,
    });
  } catch (err) {
    console.error('GET /community/posts error', err);
    return res
      .status(500)
      .json({ message: '게시글 목록을 불러오지 못했습니다.' });
  }
});

/* -----------------------------------------
 * GET /api/community/posts/:id
 * ----------------------------------------*/
router.get('/community/posts/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;

    const post = await prisma.communityPost.findUnique({
      where: { id },
      include: {
        user: true,
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { user: true },
        },
        links: {
          include: {
            issue: true,
            clipIssue: true,
          },
        },
        poll: {
          include: {
            votes: true,
          },
        },
      },
    });

    if (!post) {
      return res.status(404).json({ message: '게시글을 찾을 수 없습니다.' });
    }

    // 🔹 현재 로그인 유저 가져오기 (auth 미들웨어가 넣어준다고 가정)
    const anyReq = req as any;
    const userId: string | undefined = anyReq.user?.id ?? anyReq.userId;

    // 🔹 좋아요 여부 조회
    let liked = false;
    if (userId) {
      const existing = await prisma.communityPostLike.findUnique({
        where: {
          userId_postId: {
            userId,
            postId: id,
          },
        },
      });
      liked = !!existing;
    }

    // 조회수 증가 (에러는 무시)
    prisma.communityPost
      .update({
        where: { id },
        data: { viewsCount: { increment: 1 } },
      })
      .catch(() => {});

    const linkedIssues = post.links
      .map((link) => {
        if (link.kind === 'article' && link.issue) {
          return {
            id: link.issue.id,
            title: link.issue.title,
            type: 'article' as const,
            thumbnail: null as string | null,
          };
        }
        if (link.kind === 'clip' && link.clipIssue) {
          return {
            id: link.clipIssue.id,
            title: link.clipIssue.title,
            type: 'clip' as const,
            thumbnail: link.clipIssue.thumbnail,
          };
        }
        return null;
      })
      .filter(Boolean) as any[];

    const replies = post.comments
      .filter((c) => !c.isDeleted)
      .map((c) => mapReply(c));

    const images = Array.isArray(post.images) ? (post.images as string[]) : [];

    const poll = buildPollResponse(post.poll, userId, anyReq.sessionId);

    const isAnonymous = !!post.isAnonymous;

    return res.json({
      id: post.id,
      title: post.title,
      content: post.content,
      author: isAnonymous ? '익명' : resolveAuthor(post.user),
      authorCTI: isAnonymous ? null : post.user?.ctiType ?? null,
      likes: post.likesCount,
      comments: post.commentCount,
      views: post.viewsCount + 1,
      createdAt: post.createdAt.toISOString(),
      lounge: post.lounge,
      thumbnail: post.thumbnail,
      images,
      linkedIssues,
      replies,
      poll,
      liked,
    });
  } catch (err) {
    console.error('GET /community/posts/:id error', err);
    return res
      .status(500)
      .json({ message: '게시글을 불러오지 못했습니다.' });
  }
});

/* -----------------------------------------
 * POST /api/community/posts
 * ----------------------------------------*/
router.post(
  '/community/posts',
  requireAuth,
  async (req: any, res: Response) => {
    try {
      const user = req.user as { id: string };
      const body = req.body as {
        title: string;
        content: string;
        lounge: CommunityLounge;
        linkedIssueIds?: string[];
        images?: string[];
        poll?: {
          question: string;
          options: { id?: string; label: string }[];
        };
        isAnonymous?: boolean; // 🔥 추가
      };

      if (!body.title?.trim() || !body.content?.trim()) {
        return res
          .status(400)
          .json({ message: '제목과 내용을 입력해주세요.' });
      }

      if (!isCommunityLounge(body.lounge) || body.lounge === 'popular') {
        return res
          .status(400)
          .json({ message: '유효한 라운지를 선택해주세요.' });
      }

      const linkedIds = body.linkedIssueIds ?? [];

      let linksData: {
        kind: LinkedIssueType;
        issueId?: string;
        clipIssueId?: string;
      }[] = [];

      if (linkedIds.length > 0) {
        const issues = await prisma.issue.findMany({
          where: { id: { in: linkedIds } },
          select: { id: true },
        });

        const clips = await prisma.clipIssue.findMany({
          where: { id: { in: linkedIds } },
          select: { id: true },
        });

        linksData = [
          ...issues.map((i) => ({
            kind: 'article' as LinkedIssueType,
            issueId: i.id,
          })),
          ...clips.map((c) => ({
            kind: 'clip' as LinkedIssueType,
            clipIssueId: c.id,
          })),
        ];
      }

      const images = Array.isArray(body.images)
        ? body.images.filter(Boolean)
        : [];
      const thumbnail = images[0] ?? null;

      let pollData:
        | { question: string; options: { id: string; label: string }[] }
        | null = null;
      if (body.poll && body.poll.question?.trim()) {
        const opts = (body.poll.options ?? []).filter(
          (opt) => opt.label && String(opt.label).trim().length > 0,
        );
        if (opts.length >= 2) {
          pollData = {
            question: body.poll.question.trim(),
            options: opts.map((opt, idx) => ({
              id: opt.id ?? String(idx + 1),
              label: String(opt.label).trim(),
            })),
          };
        }
      }

      const created = await prisma.communityPost.create({
        data: {
          userId: user.id,
          lounge: body.lounge,
          title: body.title.trim(),
          content: body.content.trim(),
          thumbnail,
          isAnonymous: !!body.isAnonymous, // 🔥 추가
          ...(images.length ? { images } : {}),
          links: {
            create: linksData,
          },
          ...(pollData
            ? {
                poll: {
                  create: {
                    question: pollData.question,
                    options: pollData.options, // Json
                  },
                },
              }
            : {}),
        },
      });

      return res.status(201).json({ id: created.id });
    } catch (err) {
      console.error('POST /community/posts error', err);
      return res
        .status(500)
        .json({ message: '게시글 작성에 실패했습니다.' });
    }
  },
);

/* -----------------------------------------
 * POST /api/community/posts/:id/replies   🔥 댓글 작성
 * body: { content: string, isAnonymous?: boolean }
 * ----------------------------------------*/
router.post(
  '/community/posts/:id/replies',
  requireAuth,
  async (req: any, res: Response) => {
    try {
      const user = req.user as { id: string };
      const postId = req.params.id;
      const { content, isAnonymous } = req.body ?? {};

      if (!content || typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ message: '내용을 입력해주세요.' });
      }

      const created = await prisma.$transaction(async (tx) => {
        const exists = await tx.communityPost.findUnique({
          where: { id: postId },
          select: { id: true },
        });
        if (!exists) {
          throw new Error('POST_NOT_FOUND');
        }

        const comment = await tx.communityPostComment.create({
          data: {
            content: content.trim(),
            isAnonymous: !!isAnonymous, // 🔥 추가
            user: { connect: { id: user.id } },
            post: { connect: { id: postId } },
          },
          include: {
            user: true,
          },
        });

        await tx.communityPost.update({
          where: { id: postId },
          data: { commentCount: { increment: 1 } },
        });

        return comment;
      });

      return res.status(201).json(mapReply(created));
    } catch (err: any) {
      if (err?.message === 'POST_NOT_FOUND') {
        return res
          .status(404)
          .json({ message: '게시글을 찾을 수 없습니다.' });
      }
      console.error('POST /community/posts/:id/replies error', err);
      return res
        .status(500)
        .json({ message: '댓글 작성에 실패했습니다.' });
    }
  },
);

/* -----------------------------------------
 * POST /api/community/posts/:id/poll/vote
 * ----------------------------------------*/
router.post(
  '/community/posts/:id/poll/vote',
  async (req: Request, res: Response) => {
    try {
      const postId = req.params.id;
      const { optionId } = req.body as { optionId?: string };

      if (!optionId) {
        return res.status(400).json({ message: 'optionId가 필요합니다.' });
      }

      const anyReq = req as any;
      const userId: string | undefined = anyReq.user?.id;
      const sessionId: string | undefined = anyReq.sessionId;

      if (!userId && !sessionId) {
        return res
          .status(400)
          .json({ message: '세션 정보를 찾을 수 없습니다.' });
      }

      const post = await prisma.communityPost.findUnique({
        where: { id: postId },
        include: {
          poll: {
            include: { votes: true },
          },
        },
      });

      if (!post || !post.poll) {
        return res
          .status(404)
          .json({ message: '투표가 존재하지 않습니다.' });
      }

      if (post.poll.closedAt) {
        return res.status(400).json({ message: '이미 종료된 투표입니다.' });
      }

      const pollId = post.poll.id;

      let existingVote = null;
      if (userId) {
        existingVote = await prisma.communityPostPollVote.findFirst({
          where: { pollId, userId },
        });
      } else if (sessionId) {
        existingVote = await prisma.communityPostPollVote.findFirst({
          where: { pollId, sessionId },
        });
      }

      if (existingVote) {
        if (existingVote.optionId !== optionId) {
          await prisma.communityPostPollVote.update({
            where: { id: existingVote.id },
            data: { optionId },
          });
        }
      } else {
        await prisma.communityPostPollVote.create({
          data: {
            pollId,
            optionId,
            userId: userId ?? null,
            sessionId: sessionId ?? null,
          },
        });
      }

      const updatedPoll = await prisma.communityPostPoll.findUnique({
        where: { id: pollId },
        include: { votes: true },
      });

      const poll = buildPollResponse(
        updatedPoll,
        userId ?? null,
        sessionId ?? null,
      );

      return res.json({ poll });
    } catch (err) {
      console.error('POST /community/posts/:id/poll/vote error', err);
      return res.status(500).json({ message: '투표에 실패했습니다.' });
    }
  },
);

/* -----------------------------------------
 * GET /api/community/linked-issues
 * ----------------------------------------*/
router.get(
  '/community/linked-issues',
  async (req: Request, res: Response) => {
    try {
      const q = (req.query.q as string) || '';
      const type = req.query.type as 'article' | 'clip' | undefined;
      const search = q.trim();

      const items: {
        id: string;
        title: string;
        type: 'article' | 'clip';
        thumbnail?: string | null;
      }[] = [];

      if (!type || type === 'article') {
        const issues = await prisma.issue.findMany({
          where: search
            ? {
                title: {
                  contains: search,
                },
              }
            : {},
          orderBy: { createdAt: 'desc' },
          take: 20,
        });

        items.push(
          ...issues.map((i) => ({
            id: i.id,
            title: i.title,
            type: 'article' as const,
            thumbnail: null,
          })),
        );
      }

      if (!type || type === 'clip') {
        const clips = await prisma.clipIssue.findMany({
          where: search
            ? {
                title: {
                  contains: search,
                },
              }
            : {},
          orderBy: { createdAt: 'desc' },
          take: 20,
        });

        items.push(
          ...clips.map((c) => ({
            id: c.id,
            title: c.title,
            type: 'clip' as const,
            thumbnail: c.thumbnail,
          })),
        );
      }

      return res.json({ items });
    } catch (err) {
      console.error('GET /community/linked-issues error', err);
      return res
        .status(500)
        .json({ message: '관련 이슈 목록을 불러오지 못했습니다.' });
    }
  },
);

// ✅ POST /api/community/posts/:postId/like  (좋아요 토글)
router.post(
  '/community/posts/:postId/like',
  requireAuth,
  async (req: any, res: Response) => {
    const user = req.user as { id: string };
    const postId = req.params.postId;

    try {
      // 트랜잭션 안에서 토글 + 카운트 조정
      const result = await prisma.$transaction(async (tx) => {
        // 게시글 존재 여부 확인
        const post = await tx.communityPost.findUnique({
          where: { id: postId },
          select: { id: true },
        });

        if (!post) {
          throw new Error('POST_NOT_FOUND');
        }

        // 이미 좋아요 눌렀는지 확인
        const existing = await tx.communityPostLike.findUnique({
          where: {
            userId_postId: {
              userId: user.id,
              postId,
            },
          },
        });

        if (existing) {
          // 이미 눌렀으면 → 좋아요 취소
          await tx.communityPostLike.delete({
            where: {
              userId_postId: {
                userId: user.id,
                postId,
              },
            },
          });

          const updated = await tx.communityPost.update({
            where: { id: postId },
            data: { likesCount: { decrement: 1 } },
            select: { likesCount: true },
          });

          return {
            liked: false,
            count: Math.max(0, updated.likesCount),
          };
        } else {
          // 아직 안 눌렀으면 → 좋아요 추가
          await tx.communityPostLike.create({
            data: {
              userId: user.id,
              postId,
            },
          });

          const updated = await tx.communityPost.update({
            where: { id: postId },
            data: { likesCount: { increment: 1 } },
            select: { likesCount: true },
          });

          return {
            liked: true,
            count: updated.likesCount,
          };
        }
      });

      return res.json(result);
    } catch (err: any) {
      if (err?.message === 'POST_NOT_FOUND') {
        return res
          .status(404)
          .json({ message: '게시글을 찾을 수 없습니다.' });
      }
      console.error('POST /community/posts/:postId/like error', err);
      return res
        .status(500)
        .json({ message: '좋아요 처리 중 오류가 발생했습니다.' });
    }
  },
);

export default router;
