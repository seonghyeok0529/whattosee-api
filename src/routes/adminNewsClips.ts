// src/routes/adminNewsClips.ts
import { Router } from "express";
import { prisma } from "../lib/prisma";
import {
  ingestYoutubeNewsClips,
  clusterYoutubeNewsClips,
} from "../services/youtubeClips";

import { requireAuth } from "../middleware/requireAuth";
import { adminAuth } from "../middleware/adminAuth";

import { refreshClipIssueAIFields } from "../services/clipIssueAi";

const router = Router();

/* ----------------------------------------------------
   HTML 엔티티 디코딩 유틸 (이 파일 안에서만 사용)
---------------------------------------------------- */
function decodeHtml(str: string | null | undefined): string | null {
  // null / undefined 둘 다 여기서 처리해서 항상 string | null만 리턴
  if (str == null) return null;

  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

// 객체 전체 디코드 (string, array, nested object 포함)
// Date 같은 객체는 건들지 않도록 예외 처리
function decodeObject<T extends Record<string, any>>(obj: T): T {
  const result: Record<string, any> = {};

  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (typeof value === "string") {
      result[key] = decodeHtml(value);
    } else if (value instanceof Date) {
      result[key] = value; // 날짜는 그대로 유지
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) => {
        if (typeof v === "string") {
          return decodeHtml(v);
        }
        if (v instanceof Date) {
          return v;
        }
        if (typeof v === "object" && v !== null) {
          return decodeObject(v as Record<string, any>);
        }
        return v;
      });
    } else if (typeof value === "object" && value !== null) {
      result[key] = decodeObject(value as Record<string, any>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

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
      res.json(
        decodeObject({
          ok: true,
          ...result,
        } as Record<string, any>)
      );
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

      // 프론트 타입(AdminClipIssue)에 맞게 매핑
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
        glossaryText: issue.glossaryText,
        clipCount: issue.clipCount,
        totalViews: issue.totalViews,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        _count: issue._count,
      }));

      res.json({ items: items.map((i) => decodeObject(i)) });
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

      res.json(
        decodeObject({
          ...result,
          ok: true,
        } as Record<string, any>)
      );
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

      // 🔵 YTN 같은 특정 채널 디버깅용
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

      res.json({
        items: clips.map((c) => decodeObject(c as any)),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/admin/news-clips/clusters
 * 클립 클러스터(ClipClusterSuggestion) 목록
 */
router.get(
  "/news-clips/clusters",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const take = req.query.take ? Number(req.query.take) : 50;

      // 쿼리에서 status 받되, 기본값은 "PENDING"
      const status =
        (req.query.status as string | undefined) ?? "PENDING";

      const items = await prisma.clipClusterSuggestion.findMany({
        where: {
          status: status as any, // "PENDING" | "APPROVED" | "REJECTED"
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

      res.json({
        items: items.map((i) => decodeObject(i as any)),
      });
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
                side: (item.side as any) ?? item.rawClip?.side ?? "neutral",
              })),
          },
        },
      });

      // 4) 클러스터 상태 + clipIssueId 업데이트 (추적용)
      await prisma.clipClusterSuggestion.update({
        where: { id: cluster.id },
        data: {
          status: "APPROVED",
          clipIssueId: issue.id,
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

      // 🔗 이 클립 이슈와 연관된 다른 클립 이슈 조회
      const relations = await prisma.clipIssueRelation.findMany({
        where: {
          OR: [{ fromClipIssueId: id }, { toClipIssueId: id }],
        },
        include: {
          from: true,
          to: true,
        },
      });

      // target 이슈만 뽑아서 중복 제거
      const relatedMap = new Map<string, any>();
      for (const r of relations) {
        const target =
          r.fromClipIssueId === id ? r.to : r.from;

        if (!target) continue;
        if (target.id === id) continue;

        if (!relatedMap.has(target.id)) {
          relatedMap.set(target.id, {
            id: target.id,
            title: target.title,
            description: target.description,
            category: target.category,
            thumbnail: target.thumbnail,
            isHot: target.isHot,
            aiSummary: target.aiSummary,
            progressiveSummary: target.progressiveSummary,
            conservativeSummary: target.conservativeSummary,
            glossaryText: target.glossaryText,
            clipCount: target.clipCount,
            totalViews: target.totalViews,
            createdAt: target.createdAt,
            updatedAt: target.updatedAt,
          });
        }
      }

      const relatedClipIssues = Array.from(relatedMap.values());

      res.json({
        ok: true,
        item: decodeObject({
          ...issue,
          clips: rawClips,
          relatedClipIssues,
        } as any),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/admin/news-clips/issues
 * 클립 이슈 생성
 * body: { title, description, aiSummary, isHot, clipIds, leftSummary?, rightSummary?, fromClusterId?, glossaryText? }
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
        fromClusterId,
        glossaryText,
      } = req.body as {
        title?: string;
        description?: string | null;
        aiSummary?: string | null;
        isHot?: boolean;
        clipIds?: string[];
        leftSummary?: string | null;
        rightSummary?: string | null;
        fromClusterId?: string | null;
        glossaryText?: string | null;
      };

      if (!title || !clipIds || clipIds.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "title과 clipIds는 필수입니다.",
        });
      }

      // side NOT NULL 보호: rawClip에서 side 가져오기
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
          glossaryText: glossaryText ?? null,
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

      // fromClusterId 있으면 클러스터와 연결 + 상태 APPROVED
      if (fromClusterId) {
        try {
          await prisma.clipClusterSuggestion.update({
            where: { id: fromClusterId },
            data: {
              status: "APPROVED",
              clipIssueId: issue.id,
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
        item: decodeObject({
          ...issue,
          clips: rawClips,
        } as any),
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
        glossaryText,
      } = req.body as {
        title?: string;
        description?: string | null;
        aiSummary?: string | null;
        isHot?: boolean;
        clipIds?: string[];
        leftSummary?: string | null;
        rightSummary?: string | null;
        glossaryText?: string | null;
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
          glossaryText: glossaryText ?? null,
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
        item: decodeObject({
          ...issue,
          clips: rawClips,
        } as any),
      });
    } catch (err) {
      console.error("❌ [PATCH /admin/news-clips/issues/:id] error:", err);
      next(err);
    }
  }
);

// 🔗 클립 이슈 연관 관계 저장
// POST /api/admin/news-clips/issues/:id/relations
router.post(
  "/news-clips/issues/:id/relations",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const clipIssueId = req.params.id;
      const { targetIds } = req.body as {
        targetIds?: string[];
      };

      if (!Array.isArray(targetIds)) {
        return res
          .status(400)
          .json({ ok: false, error: "targetIds must be an array" });
      }

      // 자기 자신 제거 + 중복 제거
      const uniqueTargetIds = Array.from(
        new Set(
          targetIds.filter((tid) => tid && tid !== clipIssueId)
        )
      );

      // 존재하는 클립 이슈만 필터
      const existingTargets = await prisma.clipIssue.findMany({
        where: { id: { in: uniqueTargetIds } },
        select: { id: true },
      });
      const validTargetIds = existingTargets.map((t) => t.id);

      // 기본 정책:
      // - "이 이슈에서 나가는(from) 연관 관계" 전체를 덮어쓴다.
      await prisma.clipIssueRelation.deleteMany({
        where: { fromClipIssueId: clipIssueId },
      });

      if (validTargetIds.length > 0) {
        await prisma.clipIssueRelation.createMany({
          data: validTargetIds.map((tid) => ({
            fromClipIssueId: clipIssueId,
            toClipIssueId: tid,
            relationType: "RELATED",
            confidence: null,
          })),
          skipDuplicates: true,
        });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error(
        "❌ [POST /admin/news-clips/issues/:id/relations] error:",
        err
      );
      next(err);
    }
  }
);

// 🔄 클립 이슈 AI 요약 + 진영별 요약 재생성
// POST /api/admin/news-clips/issues/:id/refresh-summary
router.post(
  "/news-clips/issues/:id/refresh-summary",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const { id } = req.params as { id: string };

      // aiSummary + 좌/우 요약 모두 갱신
      const updated = await refreshClipIssueAIFields(id);

      if (!updated) {
        return res
          .status(404)
          .json({ ok: false, error: "Clip issue not found" });
      }

      return res.json({
        ok: true,
        item: decodeObject({
          aiSummary: updated.aiSummary ?? null,
          leftSummary: updated.progressiveSummary ?? null,
          rightSummary: updated.conservativeSummary ?? null,
        } as Record<string, any>),
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

// 🔄 진영별 요약만 재생성
// POST /api/admin/news-clips/issues/:id/refresh-side-summary
router.post(
  "/news-clips/issues/:id/refresh-side-summary",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const { id } = req.params as { id: string };

      const updated = await refreshClipIssueAIFields(id);

      if (!updated) {
        return res
          .status(404)
          .json({ ok: false, error: "Clip issue not found" });
      }

      res.json({
        ok: true,
        item: decodeObject({
          leftSummary: updated.progressiveSummary ?? null,
          rightSummary: updated.conservativeSummary ?? null,
        } as Record<string, any>),
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
// POST /api/admin/news-clips/issues/:id/refresh-glossary
router.post(
  "/news-clips/issues/:id/refresh-glossary",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const { id } = req.params as { id: string };

      const updated = await refreshClipIssueAIFields(id);

      if (!updated) {
        return res
          .status(404)
          .json({ ok: false, error: "Clip issue not found" });
      }

      return res.json({
        ok: true,
        item: decodeObject({
          glossaryText: (updated as any).glossaryText ?? null,
        } as Record<string, any>),
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
