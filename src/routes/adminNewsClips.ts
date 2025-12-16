// src/routes/adminNewsClips.ts
import { Router } from "express";
import { prisma } from "../lib/prisma";
import {
  ingestYoutubeNewsClips,
  clusterYoutubeNewsClips,
} from "../services/youtubeClips";

import { requireAuth } from "../middleware/requireAuth";
import { adminAuth } from "../middleware/adminAuth";

import {
  refreshClipIssueAIFields,
  refreshClipIssueGlossary,
} from "../services/clipIssueAi";

import { generateGlossaryText } from "../services/generateGlossary"; // ✅ 추가 (빌드 에러 해결)
import { OpenAI } from "openai";

const router = Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ----------------------------------------------------
   HTML 엔티티 디코딩 유틸 (이 파일 안에서만 사용)
---------------------------------------------------- */
function decodeHtml(str: string | null | undefined): string | null {
  if (str == null) return null;

  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

type IncomingTalkingPoint = {
  order?: number;
  title: string;
  body: string;
  kind?: string | null;
};

function sanitizeTalkingPoints(items: IncomingTalkingPoint[] | undefined) {
  if (!Array.isArray(items)) return null;

  const cleaned = items
    .filter(
      (i) => i && typeof i.title === "string" && typeof i.body === "string"
    )
    .map((i, idx) => ({
      order: typeof i.order === "number" ? i.order : idx + 1,
      title: String(i.title).slice(0, 100),
      body: String(i.body).slice(0, 800),
      kind: i.kind ? String(i.kind) : "etc",
    }));

  return cleaned;
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
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) => {
        if (typeof v === "string") return decodeHtml(v);
        if (v instanceof Date) return v;
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

/* ----------------------------------------------------
   공통 유틸: clipIds로 RawClip 로드 + 컨텍스트 문자열 만들기
---------------------------------------------------- */
async function loadRawClipsForPreview(clipIds: string[]) {
  const ids = Array.isArray(clipIds) ? clipIds.filter(Boolean) : [];
  if (ids.length === 0) return [];

  const rawClips = await prisma.rawClip.findMany({
    where: { id: { in: ids } },
  });

  // 입력 순서를 최대한 유지하고 싶으면 맵으로 재정렬
  const map = new Map(rawClips.map((c) => [c.id, c]));
  const ordered = ids.map((id) => map.get(id)).filter(Boolean) as typeof rawClips;

  return ordered.length ? ordered : rawClips;
}

function buildClipsSummaryForPrompt(rawClips: any[]) {
  return (rawClips ?? [])
    .map((c: any) => {
      const side =
        c.side === "left" ? "진보" : c.side === "right" ? "보수" : "중립";
      const title = c.title ?? "(제목 없음)";
      const channel = c.channel ?? "채널";
      return `- [${side}] ${channel}: ${title}`;
    })
    .join("\n");
}

function buildClipsTextForGlossary(rawClips: any[]) {
  return (rawClips ?? [])
    .map((c: any) => {
      const ch = c.channel ?? "채널";
      const t = c.title ?? "(제목 없음)";
      return `- [${ch}] ${t}`;
    })
    .join("\n");
}

/**
 * POST /api/admin/news-clips/ingest
 */
router.post("/news-clips/ingest", requireAuth, adminAuth, async (req, res, next) => {
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
});

/**
 * GET /api/admin/news-clips/issues
 */
router.get("/news-clips/issues", requireAuth, adminAuth, async (req, res, next) => {
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
});

/**
 * POST /api/admin/news-clips/cluster
 */
router.post("/news-clips/cluster", requireAuth, adminAuth, async (req, res, next) => {
  try {
    const minGroupSize = req.body?.minGroupSize ? Number(req.body.minGroupSize) : undefined;
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
});

/**
 * GET /api/admin/news-clips/raw
 */
router.get("/news-clips/raw", requireAuth, adminAuth, async (req, res, next) => {
  try {
    const take = req.query.take ? Number(req.query.take) : 50;

    const clips = await prisma.rawClip.findMany({
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
      take,
    });

    const ytnClips = clips.filter((c) => (c.channel ?? "").toLowerCase().includes("ytn"));

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
});

/**
 * GET /api/admin/news-clips/clusters
 */
router.get("/news-clips/clusters", requireAuth, adminAuth, async (req, res, next) => {
  try {
    const take = req.query.take ? Number(req.query.take) : 50;

    const status = (req.query.status as string | undefined) ?? "PENDING";

    const items = await prisma.clipClusterSuggestion.findMany({
      where: { status: status as any },
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
});

/**
 * POST /api/admin/news-clips/approve
 */
router.post("/news-clips/approve", requireAuth, adminAuth, async (req, res, next) => {
  try {
    const { clusterId } = req.body as { clusterId?: string };

    if (!clusterId) {
      return res.status(400).json({ ok: false, error: "clusterId is required" });
    }

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
      return res.status(404).json({ ok: false, error: "Cluster not found" });
    }

    if (cluster.items.length === 0) {
      return res.status(400).json({ ok: false, error: "Cluster has no items" });
    }

    const firstItem = cluster.items[0];
    const firstRaw = firstItem.rawClip;

    const title = cluster.title || "유튜브 뉴스 클립 이슈";
    const description = cluster.summary ?? null;
    const thumbnail = firstRaw?.thumbnail ?? null;

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

    await prisma.clipClusterSuggestion.update({
      where: { id: cluster.id },
      data: {
        status: "APPROVED",
        clipIssueId: issue.id,
      },
    });

    res.json({
      ok: true,
      issueId: issue.id,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/news-clips/issues/:id
 */
router.get("/news-clips/issues/:id", requireAuth, adminAuth, async (req, res, next) => {
  try {
    const id = req.params.id;

    const issue = await prisma.clipIssue.findUnique({
      where: { id },
      include: {
        clips: { include: { rawClip: true } },
        talkingPoints: { orderBy: { order: "asc" } },
      },
    });

    if (!issue) {
      return res.status(404).json({ ok: false, error: "Clip issue not found" });
    }

    const rawClips = issue.clips.map((ic) => ic.rawClip);

    const relations = await prisma.clipIssueRelation.findMany({
      where: { OR: [{ fromClipIssueId: id }, { toClipIssueId: id }] },
      include: { from: true, to: true },
    });

    const relatedMap = new Map<string, any>();
    for (const r of relations) {
      const target = r.fromClipIssueId === id ? r.to : r.from;
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
});

/* =========================================================
   ✅ (NEW) 등록 전 편집 페이지용 PREVIEW API
   - DB 저장 없이 clipIds 기준으로 AI 생성
   - 프론트에서 "생성" 버튼 눌렀을 때 여기 호출하면 됨
========================================================= */

/**
 * POST /api/admin/news-clips/preview/refresh-talking-points
 * body: { title?, description?, aiSummary?, clipIds: string[] }
 */
router.post(
  "/news-clips/preview/refresh-talking-points",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const body = req.body as {
        title?: string;
        description?: string | null;
        aiSummary?: string | null;
        clipIds?: string[];
      };

      const title = body.title ?? "";
      const description = body.description ?? "";
      const aiSummary = body.aiSummary ?? "";
      const clipIds = Array.isArray(body.clipIds) ? body.clipIds : [];

      if (!clipIds.length) {
        return res.status(400).json({ ok: false, error: "clipIds is required" });
      }

      const rawClips = await loadRawClipsForPreview(clipIds);
      if (!rawClips.length) {
        return res.status(400).json({ ok: false, error: "유효한 rawClip이 없습니다." });
      }

      const clipsSummary = buildClipsSummaryForPrompt(rawClips);

      const prompt = `
너는 한국어로 유튜브 뉴스 클립 이슈의 핵심 쟁점을 뽑는 에디터야.

아래 정보를 보고, 시청자가 이 이슈를 이해할 때
"어디에 집중해서 봐야 하는지"를 알려주는 쟁점 리스트를 만들어라.

[이슈 제목]
${title}

[이슈 설명]
${description}

[AI 요약]
${aiSummary}

[포함된 클립 목록]
${clipsSummary || "(클립 정보 없음)"}

규칙:
1) JSON 배열만 출력 (설명 금지)
2) 각 항목 필드:
   - order (1부터)
   - title (짧게)
   - body (2~3문장)
   - kind: "fact" | "conflict" | "impact" | "future" | "etc"
3) 3~7개
4) 한국어
`.trim();

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "너는 한국 정치·사회 이슈의 쟁점 리스트를 만드는 한국어 에디터이다. 반드시 JSON 배열만 출력한다.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
      });

      const raw = completion.choices[0]?.message?.content ?? "[]";

      let parsed: any[] = [];
      try {
        const tmp = JSON.parse(raw);
        if (Array.isArray(tmp)) parsed = tmp;
      } catch (e) {
        console.error("[preview refresh-talking-points] JSON parse error:", e, "raw=", raw);
      }

      const items = parsed
        .filter((p) => p && typeof p.title === "string" && typeof p.body === "string")
        .slice(0, 7)
        .map((p, idx) => ({
          order: typeof p.order === "number" ? p.order : idx + 1,
          title: String(p.title).slice(0, 100),
          body: String(p.body).slice(0, 800),
          kind: typeof p.kind === "string" ? p.kind : "etc",
        }));

      return res.json({ ok: true, items: decodeObject(items as any) });
    } catch (err) {
      console.error("❌ [POST /admin/news-clips/preview/refresh-talking-points] error:", err);
      next(err);
    }
  }
);

/**
 * POST /api/admin/news-clips/preview/refresh-glossary
 * body: { title?, description?, aiSummary?, clipIds: string[] }
 */
router.post(
  "/news-clips/preview/refresh-glossary",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const body = req.body as {
        title?: string;
        description?: string | null;
        aiSummary?: string | null;
        clipIds?: string[];
      };

      const title = body.title ?? "";
      const description = body.description ?? null;
      const aiSummary = body.aiSummary ?? null;
      const clipIds = Array.isArray(body.clipIds) ? body.clipIds : [];

      if (!clipIds.length) {
        return res.status(400).json({ ok: false, error: "clipIds is required" });
      }

      const rawClips = await loadRawClipsForPreview(clipIds);
      if (!rawClips.length) {
        return res.status(400).json({ ok: false, error: "유효한 rawClip이 없습니다." });
      }

      const clipsText = buildClipsTextForGlossary(rawClips);

      const glossaryText = await generateGlossaryText({
        title: title || "뉴스 클립 이슈",
        summary: aiSummary ?? description ?? null,
        itemsText: clipsText,
        locale: "ko",
        sourceType: "clip",
      });

      return res.json({
        ok: true,
        item: decodeObject({ glossaryText: glossaryText ?? null } as any),
      });
    } catch (err) {
      console.error("❌ [POST /admin/news-clips/preview/refresh-glossary] error:", err);
      next(err);
    }
  }
);

/**
 * POST /api/admin/news-clips/preview/refresh-ai
 * body: { title?, description?, aiSummary?, clipIds: string[] }
 * -> talkingPoints + glossaryText 한 번에 받기
 */
router.post(
  "/news-clips/preview/refresh-ai",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const body = req.body as {
        title?: string;
        description?: string | null;
        aiSummary?: string | null;
        clipIds?: string[];
      };

      const title = body.title ?? "";
      const description = body.description ?? "";
      const aiSummary = body.aiSummary ?? "";
      const clipIds = Array.isArray(body.clipIds) ? body.clipIds : [];

      if (!clipIds.length) {
        return res.status(400).json({ ok: false, error: "clipIds is required" });
      }

      const rawClips = await loadRawClipsForPreview(clipIds);
      if (!rawClips.length) {
        return res.status(400).json({ ok: false, error: "유효한 rawClip이 없습니다." });
      }

      const clipsSummary = buildClipsSummaryForPrompt(rawClips);
      const clipsText = buildClipsTextForGlossary(rawClips);

      const tpPrompt = `
너는 한국어로 유튜브 뉴스 클립 이슈의 핵심 쟁점을 뽑는 에디터야.

[이슈 제목]
${title}

[이슈 설명]
${description}

[AI 요약]
${aiSummary}

[포함된 클립 목록]
${clipsSummary || "(클립 정보 없음)"}

규칙:
1) JSON 배열만 출력
2) 각 항목: order/title/body/kind ("fact"|"conflict"|"impact"|"future"|"etc")
3) 3~7개
`.trim();

      const [tpCompletion, glossaryText] = await Promise.all([
        openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            {
              role: "system",
              content:
                "너는 한국 정치·사회 이슈의 쟁점 리스트를 만드는 한국어 에디터이다. 반드시 JSON 배열만 출력한다.",
            },
            { role: "user", content: tpPrompt },
          ],
          temperature: 0.4,
        }),
        generateGlossaryText({
          title: title || "뉴스 클립 이슈",
          summary: aiSummary || description || null,
          itemsText: clipsText,
          locale: "ko",
          sourceType: "clip",
        }),
      ]);

      const raw = tpCompletion.choices[0]?.message?.content ?? "[]";
      let parsed: any[] = [];
      try {
        const tmp = JSON.parse(raw);
        if (Array.isArray(tmp)) parsed = tmp;
      } catch (e) {
        console.error("[preview refresh-ai] JSON parse error:", e, "raw=", raw);
      }

      const talkingPoints = parsed
        .filter((p) => p && typeof p.title === "string" && typeof p.body === "string")
        .slice(0, 7)
        .map((p, idx) => ({
          order: typeof p.order === "number" ? p.order : idx + 1,
          title: String(p.title).slice(0, 100),
          body: String(p.body).slice(0, 800),
          kind: typeof p.kind === "string" ? p.kind : "etc",
        }));

      return res.json({
        ok: true,
        item: decodeObject({
          glossaryText: glossaryText ?? null,
          talkingPoints,
        } as any),
      });
    } catch (err) {
      console.error("❌ [POST /admin/news-clips/preview/refresh-ai] error:", err);
      next(err);
    }
  }
);

/**
 * POST /api/admin/news-clips/issues
 */
router.post("/news-clips/issues", requireAuth, adminAuth, async (req, res, next) => {
  try {
    const body = req.body as {
      title?: string;
      description?: string | null;
      aiSummary?: string | null;
      isHot?: boolean;
      clipIds?: string[];
      fromClusterId?: string | null;
      glossaryText?: string | null;
      talkingPoints?: IncomingTalkingPoint[];
    };

    const { title, description, aiSummary, isHot, clipIds, fromClusterId, glossaryText, talkingPoints } = body;

    if (!title || !clipIds || clipIds.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "title과 clipIds는 필수입니다.",
      });
    }

    const rawClipsInIssue = await prisma.rawClip.findMany({
      where: { id: { in: clipIds } },
    });

    if (rawClipsInIssue.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "유효한 rawClip이 없습니다.",
      });
    }

    const cleanedTalkingPoints = sanitizeTalkingPoints(talkingPoints);

    const issue = await prisma.clipIssue.create({
      data: {
        title,
        description: description ?? null,
        aiSummary: aiSummary ?? null,
        isHot: !!isHot,
        clipCount: clipIds.length,
        totalViews: 0,
        glossaryText: glossaryText ?? null,
        clips: {
          create: rawClipsInIssue.map((c) => ({
            rawClip: { connect: { id: c.id } },
            side: (c.side as any) ?? "neutral",
          })),
        },
        ...(cleanedTalkingPoints && {
          talkingPoints: {
            create: cleanedTalkingPoints,
          },
        }),
      },
      include: {
        clips: { include: { rawClip: true } },
        talkingPoints: { orderBy: { order: "asc" } },
      },
    });

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
        console.error("⚠️ clipClusterSuggestion link/update failed:", e);
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
});

/**
 * PATCH /api/admin/news-clips/issues/:id
 */
router.patch("/news-clips/issues/:id", requireAuth, adminAuth, async (req, res, next) => {
  try {
    const id = req.params.id;

    const body = req.body as {
      title?: string;
      description?: string | null;
      aiSummary?: string | null;
      isHot?: boolean;
      clipIds?: string[];
      glossaryText?: string | null;
      talkingPoints?: IncomingTalkingPoint[];
    };

    const { title, description, aiSummary, isHot, clipIds, glossaryText, talkingPoints } = body;

    const clipIdsSafe = clipIds ?? [];

    const rawClipsInIssue = clipIdsSafe.length
      ? await prisma.rawClip.findMany({
          where: { id: { in: clipIdsSafe } },
        })
      : [];

    const cleanedTalkingPoints = sanitizeTalkingPoints(talkingPoints);

    const data: any = {
      title,
      description: description ?? null,
      aiSummary: aiSummary ?? null,
      isHot: !!isHot,
      clipCount: clipIdsSafe.length,
      glossaryText: glossaryText ?? null,
      clips: {
        deleteMany: {},
        create: rawClipsInIssue.map((c) => ({
          rawClip: { connect: { id: c.id } },
          side: (c.side as any) ?? "neutral",
        })),
      },
    };

    if (cleanedTalkingPoints) {
      data.talkingPoints = {
        deleteMany: {},
        create: cleanedTalkingPoints,
      };
    }

    const issue = await prisma.clipIssue.update({
      where: { id },
      data,
      include: {
        clips: { include: { rawClip: true } },
        talkingPoints: { orderBy: { order: "asc" } },
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
});

// 🔗 클립 이슈 연관 관계 저장
router.post("/news-clips/issues/:id/relations", requireAuth, adminAuth, async (req, res, next) => {
  try {
    const clipIssueId = req.params.id;
    const { targetIds } = req.body as { targetIds?: string[] };

    if (!Array.isArray(targetIds)) {
      return res.status(400).json({ ok: false, error: "targetIds must be an array" });
    }

    const uniqueTargetIds = Array.from(new Set(targetIds.filter((tid) => tid && tid !== clipIssueId)));

    const existingTargets = await prisma.clipIssue.findMany({
      where: { id: { in: uniqueTargetIds } },
      select: { id: true },
    });
    const validTargetIds = existingTargets.map((t) => t.id);

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
    console.error("❌ [POST /admin/news-clips/issues/:id/relations] error:", err);
    next(err);
  }
});

/**
 * 🔄 클립 이슈 쟁점 리스트(AI) 재생성 (DB 저장)
 */
router.post(
  "/news-clips/issues/:id/refresh-talking-points",
  requireAuth,
  adminAuth,
  async (req, res, next) => {
    try {
      const { id } = req.params as { id: string };

      const issue = await prisma.clipIssue.findUnique({
        where: { id },
        include: {
          clips: { include: { rawClip: true } },
        },
      });

      if (!issue) {
        return res.status(404).json({ ok: false, error: "Clip issue not found" });
      }

      const clipsSummary = (issue.clips ?? [])
        .map((c) => {
          const side = c.side === "left" ? "진보" : c.side === "right" ? "보수" : "중립";
          const title = c.rawClip?.title ?? "(제목 없음)";
          const channel = c.rawClip?.channel ?? "채널";
          return `- [${side}] ${channel}: ${title}`;
        })
        .join("\n");

      const prompt = `
너는 한국어로 유튜브 뉴스 클립 이슈의 핵심 쟁점을 뽑는 에디터야.

[이슈 제목]
${issue.title ?? ""}

[이슈 설명]
${issue.description ?? ""}

[AI 요약]
${issue.aiSummary ?? ""}

[포함된 클립 목록]
${clipsSummary || "(클립 정보 없음)"}

규칙:
1) JSON 배열만 출력
2) order/title/body/kind
3) 3~7개
`.trim();

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "너는 한국 정치·사회 이슈의 쟁점 리스트를 만드는 한국어 에디터이다. 반드시 JSON 배열만 출력한다.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
      });

      const raw = completion.choices[0]?.message?.content ?? "[]";

      let parsed: any[] = [];
      try {
        const tmp = JSON.parse(raw);
        if (Array.isArray(tmp)) parsed = tmp;
      } catch (e) {
        console.error("[refresh-talking-points clips] JSON parse error:", e, "raw=", raw);
      }

      const talkingPoints = parsed
        .filter((p) => p && typeof p.title === "string" && typeof p.body === "string")
        .slice(0, 7)
        .map((p, idx) => ({
          order: typeof p.order === "number" ? p.order : idx + 1,
          title: String(p.title).slice(0, 100),
          body: String(p.body).slice(0, 800),
          kind: typeof p.kind === "string" ? p.kind : "etc",
        }));

      const updated = await prisma.clipIssue.update({
        where: { id },
        data: {
          talkingPoints: {
            deleteMany: {},
            create: talkingPoints.map((tp) => ({
              order: tp.order,
              title: tp.title,
              body: tp.body,
              kind: tp.kind,
            })),
          },
        },
        include: {
          talkingPoints: { orderBy: { order: "asc" } },
        },
      });

      return res.json({
        ok: true,
        items: updated.talkingPoints,
      });
    } catch (err) {
      console.error("❌ [POST /api/admin/news-clips/issues/:id/refresh-talking-points] error:", err);
      next(err);
    }
  }
);

/**
 * ✏️ 클립 이슈 쟁점 리스트 수동 저장
 */
router.put("/news-clips/issues/:id/talking-points", requireAuth, adminAuth, async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const { items } = req.body as {
      items?: { order?: number; title: string; body: string; kind?: string | null }[];
    };

    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: "items must be an array" });
    }

    const cleaned = items
      .filter((i) => i && typeof i.title === "string" && typeof i.body === "string")
      .map((i, idx) => ({
        order: typeof i.order === "number" ? i.order : idx + 1,
        title: String(i.title).slice(0, 100),
        body: String(i.body).slice(0, 800),
        kind: i.kind ? String(i.kind) : "etc",
      }));

    const updated = await prisma.clipIssue.update({
      where: { id },
      data: {
        talkingPoints: {
          deleteMany: {},
          create: cleaned,
        },
      },
      include: {
        talkingPoints: { orderBy: { order: "asc" } },
      },
    });

    return res.json({
      ok: true,
      items: decodeObject(updated.talkingPoints as any),
    });
  } catch (err) {
    console.error("❌ [PUT /admin/news-clips/issues/:id/talking-points] error:", err);
    next(err);
  }
});

/**
 * 🔄 클립 이슈 AI 요약 재생성
 */
router.post("/news-clips/issues/:id/refresh-summary", requireAuth, adminAuth, async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };

    const updated = await refreshClipIssueAIFields(id);

    if (!updated) {
      return res.status(404).json({ ok: false, error: "Clip issue not found" });
    }

    return res.json({
      ok: true,
      item: decodeObject({
        aiSummary: updated.aiSummary ?? null,
      } as Record<string, any>),
    });
  } catch (err) {
    console.error("❌ [POST /api/admin/news-clips/issues/:id/refresh-summary] error:", err);
    next(err);
  }
});

/**
 * 🔄 클립 이슈 용어 사전 재생성
 */
router.post("/news-clips/issues/:id/refresh-glossary", requireAuth, adminAuth, async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };

    const updated = await refreshClipIssueGlossary(id);

    if (!updated) {
      return res.status(404).json({ ok: false, error: "Clip issue not found" });
    }

    return res.json({
      ok: true,
      item: decodeObject({
        glossaryText: updated.glossaryText ?? null,
      } as Record<string, any>),
    });
  } catch (err) {
    console.error("❌ [POST /api/admin/news-clips/issues/:id/refresh-glossary] error:", err);
    next(err);
  }
});

export default router;
