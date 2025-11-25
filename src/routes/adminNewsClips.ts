// src/routes/adminNewsClips.ts
import { Router } from "express";
import { prisma } from "../lib/prisma";
import {
  ingestYoutubeNewsClips,
  clusterYoutubeNewsClips,
} from "../services/youtubeClips"; 
 
// ✅ adminIssueRoutes와 같은 경로 스타일 사용
import { requireAuth } from "../middleware/requireAuth";
import { adminAuth } from "../middleware/adminAuth";

import { refreshClipIssueAIFields } from "../services/clipIssueAi";

const router = Router();

/**
 * POST /api/admin/news-clips/ingest
 * 최근 N시간 유튜브 뉴스 클립 RawClip으로 수집 
 */
router.post(
  "/news-clips/ingest",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const hours = req.body?.hours ? Number(req.body.hours) : undefined;
      const result = await ingestYoutubeNewsClips({ hours });
      res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/news-clips/issues",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const take = req.query.take ? Number(req.query.take) : 100;

      const issues = await prisma.clipIssue.findMany({
        take,
        orderBy: { createdAt: "desc" },
        include: {
          _count: {
            select: {
              clips: true,
              comments: true,
            },
          },
        },
      });

      // 프론트 타입과 맞게 매핑 (AdminClipIssue)
      const items = issues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        description: issue.description,
        category: issue.category,
        thumbnail: issue.thumbnail,
        isHot: issue.isHot,
        aiSummary: issue.aiSummary,
        progressiveSummary: issue.progressiveSummary,
        conservativeSummary: issue.conservativeSummary,
        clipCount: issue.clipCount,
        totalViews: issue.totalViews,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        _count: issue._count,
      }));

      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/admin/news-clips/cluster
 * RawClip → ClipClusterSuggestion 생성
 */
router.post(
  "/news-clips/cluster",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const minGroupSize = req.body?.minGroupSize
        ? Number(req.body.minGroupSize)
        : undefined;

      const result = await clusterYoutubeNewsClips({ minGroupSize });

      res.json({
        ...result,
        ok: true,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/admin/news-clips/raw
 * 디버그용: 최근 RawClip 리스트
 */
router.get(
  "/news-clips/raw",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const take = req.query.take ? Number(req.query.take) : 50;

      const clips = await prisma.rawClip.findMany({
        orderBy: [
          { publishedAt: "desc" },
          { createdAt: "desc" },
        ],
        take,
      });

      // 🔵 여기서 찍기!
      const ytnClips = clips.filter((c) =>
        (c.channel ?? "").toLowerCase().includes("ytn")
      );

      console.log("[DEBUG /admin/news-clips/raw] total:", clips.length);
      console.log(
        "[DEBUG /admin/news-clips/raw] YTN clips in response:",
        ytnClips.length,
        ytnClips.slice(0, 3).map((c) => ({
          id: c.id,
          title: c.title,
          channel: c.channel,
          publishedAt: c.publishedAt,
          createdAt: c.createdAt,
        }))
      );

      res.json({ items: clips });
    } catch (err) {
      next(err);
    }
  }
);




/**
 * GET /api/admin/news-clips/issues
 * 클립 이슈(ClipIssue) 목록
 */
router.get(
  "/news-clips/clusters",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const take = req.query.take ? Number(req.query.take) : 50;

      // 🔹 쿼리에서 status 받되, 기본값은 "PENDING"
      const status =
        (req.query.status as string | undefined) ?? "PENDING";

      const items = await prisma.clipClusterSuggestion.findMany({
        where: {
          status: status as any,   // "PENDING" | "APPROVED" | "REJECTED"
        },
        orderBy: { createdAt: "desc" },
        take,
        include: {
          items: {
            include: {
              rawClip: true,
            },
          },
        },
      });

      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/admin/news-clips/approve
 * ClipClusterSuggestion → ClipIssue로 승격
 * body: { clusterId: string }
 */
router.post(
  "/news-clips/approve",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const { clusterId } = req.body as { clusterId?: string };

      if (!clusterId) {
        return res
          .status(400)
          .json({ ok: false, error: "clusterId is required" });
      }

      // 1) 클러스터 조회 (아이템 + rawClip 포함)
      const cluster = await prisma.clipClusterSuggestion.findUnique({
        where: { id: clusterId },
        include: {
          items: {
            include: {
              rawClip: true,
            },
          },
        },
      });

      if (!cluster) {
        return res
          .status(404)
          .json({ ok: false, error: "Cluster not found" });
      }

      if (cluster.items.length === 0) {
        return res
          .status(400)
          .json({ ok: false, error: "Cluster has no items" });
      }

      // 2) 대표 썸네일/카테고리 등 간단 결정
      const firstItem = cluster.items[0];
      const firstRaw = firstItem.rawClip;

      const title = cluster.title || "유튜브 뉴스 클립 이슈";
      const description = cluster.summary ?? null;
      const thumbnail = firstRaw?.thumbnail ?? null;

      // 3) ClipIssue 생성 + ClipIssueClip 연결
      const issue = await prisma.clipIssue.create({
        data: {
          title,
          description,
          thumbnail,
          isHot: false,
          clipCount: cluster.items.length,
          totalViews: 0,
          clips: {
            create: cluster.items
              .filter((item) => item.rawClipId || item.rawClip?.id)
              .map((item) => ({
                rawClip: {
                  connect: {
                    id: item.rawClipId ?? item.rawClip!.id,
                  },
                },
                side: item.side ?? item.rawClip?.side ?? "neutral",
              })),
          },
        },
      });

      // 4) 클러스터 상태 업데이트
      await prisma.clipClusterSuggestion.update({
        where: { id: cluster.id },
        data: {
          status: "APPROVED",
        },
      });

      // 5) 프론트가 바로 편집 페이지로 이동할 수 있도록 issueId 반환
      res.json({
        ok: true,
        issueId: issue.id,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/admin/news-clips/issues/:id
 * 클립 이슈 상세
 */
router.get(
  "/news-clips/issues/:id",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const id = req.params.id;

      const issue = await prisma.clipIssue.findUnique({
        where: { id },
        include: {
          clips: {
            include: { rawClip: true },
          },
        },
      });

      if (!issue) {
        return res
          .status(404)
          .json({ ok: false, error: "Clip issue not found" });
      }

      // rawClip 배열만 뽑아서 프론트가 쓰기 쉽게 정리
      const rawClips = issue.clips.map((ic) => ic.rawClip);

      res.json({
        ok: true,
        item: {
          ...issue,
          clips: rawClips,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/admin/news-clips/issues
 * 클립 이슈 생성
 * body: { title, description, aiSummary, isHot, clipIds, leftSummary?, rightSummary? }
 */
router.post(
  "/news-clips/issues",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const {
        title,
        description,
        aiSummary,
        isHot,
        clipIds,
        leftSummary,
        rightSummary,
        fromClusterId,        // 🔹 추가
      } = req.body as {
        title?: string;
        description?: string | null;
        aiSummary?: string | null;
        isHot?: boolean;
        clipIds?: string[];
        leftSummary?: string | null;
        rightSummary?: string | null;
        fromClusterId?: string | null;  // 🔹 추가
      };

      if (!title || !clipIds || clipIds.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "title과 clipIds는 필수입니다.",
        });
      }

      // ✅ side NOT NULL 보호: rawClip에서 side 가져오기
      const rawClipsInIssue = await prisma.rawClip.findMany({
        where: {
          id: { in: clipIds },
        },
      });

      if (rawClipsInIssue.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "유효한 rawClip이 없습니다.",
        });
      }

      const issue = await prisma.clipIssue.create({
        data: {
          title,
          description: description ?? null,
          aiSummary: aiSummary ?? null,
          isHot: !!isHot,
          clipCount: clipIds.length,
          totalViews: 0,
          progressiveSummary: leftSummary ?? null,
          conservativeSummary: rightSummary ?? null,
          clips: {
            create: rawClipsInIssue.map((c) => ({
              rawClip: { connect: { id: c.id } },
              side: (c.side as any) ?? "neutral",
            })),
          },
        },
        include: {
          clips: { include: { rawClip: true } },
        },
      });

      // 🔹 여기 추가: fromClusterId 가 있으면 해당 클러스터를 APPROVED + issueId 연결
      if (fromClusterId) {
        try {
          await prisma.clipClusterSuggestion.update({
            where: { id: fromClusterId },
            data: {
              status: "APPROVED",
              clipIssueId: issue.id,      // Prisma 모델에 issueId 필드 있다고 가정
            },
          });
        } catch (e) {
          console.error(
            "⚠️ clipClusterSuggestion link/update failed:",
            e
          );
        }
      }

      const rawClips = issue.clips.map((ic) => ic.rawClip);

      res.json({
        ok: true,
        item: {
          ...issue,
          clips: rawClips,
        },
      });
    } catch (err) {
      console.error("❌ [POST /admin/news-clips/issues] error:", err);
      next(err);
    }
  }
);

/**
 * PATCH /api/admin/news-clips/issues/:id
 * 클립 이슈 수정
 */
router.patch(
  "/news-clips/issues/:id",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      const {
        title,
        description,
        aiSummary,
        isHot,
        clipIds,
        leftSummary,
        rightSummary,
      } = req.body as {
        title?: string;
        description?: string | null;
        aiSummary?: string | null;
        isHot?: boolean;
        clipIds?: string[];
        leftSummary?: string | null;
        rightSummary?: string | null;
      };

      const clipIdsSafe = clipIds ?? [];

      // side 설정을 위해 rawClip 먼저 조회
      const rawClipsInIssue = clipIdsSafe.length
        ? await prisma.rawClip.findMany({
            where: { id: { in: clipIdsSafe } },
          })
        : [];

      const issue = await prisma.clipIssue.update({
        where: { id },
        data: {
          title,
          description: description ?? null,
          aiSummary: aiSummary ?? null,
          isHot: !!isHot,
          clipCount: clipIdsSafe.length,
          progressiveSummary: leftSummary ?? null,
          conservativeSummary: rightSummary ?? null,
          clips: {
            deleteMany: {}, // 이전 연결 전부 제거
            create: rawClipsInIssue.map((c) => ({
              rawClip: { connect: { id: c.id } },
              side: (c.side as any) ?? "neutral",
            })),
          },
        },
        include: {
          clips: { include: { rawClip: true } },
        },
      });

      const rawClips = issue.clips.map((ic) => ic.rawClip);

      res.json({
        ok: true,
        item: {
          ...issue,
          clips: rawClips,
        },
      });
    } catch (err) {
      console.error("❌ [PATCH /admin/news-clips/issues/:id] error:", err);
      next(err);
    }
  }
);

/**
 * (선택) 클립 이슈 요약 재생성 엔드포인트
 * - 프론트 refreshClipIssueSummary / refreshClipIssueSideSummary 에 맞추는 stub
 * - 나중에 LLM 요약 로직 연결해도 됨
 */
/**
 * (선택) 클립 이슈 요약 재생성 엔드포인트
 * - 프론트 refreshClipIssueSummary / refreshClipIssueSideSummary 에 맞추는 stub
 * - 나중에 LLM 요약 로직 연결해도 됨
 */
// 🔄 클립 이슈 AI 요약 + 진영별 요약 재생성
router.post(
    "/news-clips/issues/:id/refresh-summary",
    requireAuth,
    adminAuth,
    async (req, res, next) => {
      try {
        const { id } = req.params as { id: string };
  
        // ✅ clipIssueAi 서비스 호출해서: aiSummary + progressive/conservativeSummary 모두 갱신
        const updated = await refreshClipIssueAIFields(id);
  
        if (!updated) {
          return res
            .status(404)
            .json({ ok: false, error: "Clip issue not found" });
        }
  
        return res.json({
          ok: true,
          item: {
            // 프론트 타입에 맞춰서 최소한 이 세 개는 보내주기
            aiSummary: updated.aiSummary ?? null,
            leftSummary: updated.progressiveSummary ?? null,
            rightSummary: updated.conservativeSummary ?? null,
          },
        });
      } catch (err) {
        console.error(
          "❌ [POST /admin/news-clips/issues/:id/refresh-summary] error:",
          err
        );
        next(err);
      }
    }
  );
  

  router.post(
    "/news-clips/issues/:id/refresh-side-summary",
    requireAuth,
    adminAuth,
    async (req, res, next) => {
      try {
        const { id } = req.params as { id: string };
  
        // 여기서도 같은 서비스 재사용 (요약이 이미 갱신되어 있다고 가정해도 되고,
        // 한 번 더 돌려도 되고, 구현에 따라 선택)
        const updated = await refreshClipIssueAIFields(id);
  
        if (!updated) {
          return res
            .status(404)
            .json({ ok: false, error: "Clip issue not found" });
        }
  
        res.json({
          ok: true,
          item: {
            leftSummary: updated.progressiveSummary ?? null,
            rightSummary: updated.conservativeSummary ?? null,
          },
        });
      } catch (err) {
        console.error(
          "❌ [POST /admin/news-clips/issues/:id/refresh-side-summary] error:",
          err
        );
        next(err);
      }
    }
  );

// 🔄 클립 이슈 용어 사전 재생성
router.post(
  "/news-clips/issues/:id/refresh-glossary",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const { id } = req.params as { id: string };

      // 기존에 쓰고 있는 AI 필드 갱신 서비스 재사용
      const updated = await refreshClipIssueAIFields(id);

      if (!updated) {
        return res
          .status(404)
          .json({ ok: false, error: "Clip issue not found" });
      }

      return res.json({
        ok: true,
        item: {
          glossaryText: (updated as any).glossaryText ?? null,
        },
      });
    } catch (err) {
      console.error(
        "❌ [POST /admin/news-clips/issues/:id/refresh-glossary] error:",
        err
      );
      next(err);
    }
  }
);

  

export default router;
