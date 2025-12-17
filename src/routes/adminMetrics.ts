// src/routes/adminMetrics.ts
import { Router } from "express";
import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { adminAuth } from "../middleware/adminAuth";

const router = Router();

/* ─────────────────────────────────────────────
   KST Date Utils (서버 TZ와 무관하게 KST 기준 유지)
   - "KST 자정"을 UTC Date로 정확히 만들어줌
───────────────────────────────────────────── */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 어떤 Date를 KST 자정 시작(00:00 KST)의 UTC Date로 변환 */
function startOfDayKST(d = new Date()) {
  // 1) 시간을 KST로 "옮긴" 다음
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  // 2) 그 KST 시간을 "UTC 기준 자정"으로 맞추고
  k.setUTCHours(0, 0, 0, 0);
  // 3) 다시 UTC로 되돌림
  return new Date(k.getTime() - KST_OFFSET_MS);
}

/** KST 기준으로 n일 전(자정 기준)의 UTC Date */
function daysAgoKST(n: number) {
  const todayStart = startOfDayKST(new Date());
  const d = new Date(todayStart);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/** KST 기준 YYYY-MM-DD dayKey */
function dayKeyKST(d = new Date()) {
  const kstMs = d.getTime() + KST_OFFSET_MS;
  return new Date(kstMs).toISOString().slice(0, 10);
}

/** 최근 n일의 dayKey 배열 (KST 기준) */
function lastNDatesKST(n: number) {
  const out: string[] = [];
  const todayStart = startOfDayKST(new Date());
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(todayStart);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(dayKeyKST(d));
  }
  return out;
}

async function safe<T>(label: string, fn: () => Promise<T>, fb: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[admin/metrics] safe(${label}) failed:`, e);
    return fb;
  }
}

function union<T>(...sets: Set<T>[]) {
  const out = new Set<T>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}

type DailyTable =
  | "Issue"
  | "Agenda"
  | "IssueComment"
  | "AgendaComment"
  | "ClipIssue"
  | "ClipIssueComment";

type DailyCountOpts = {
  /** ✅ 등록된 이슈만 집계: Issue.status != 'SUGGESTED' */
  issueRegisteredOnly?: boolean;
};

/**
 * ✅ Postgres: createdAt을 KST(+9h)로 날짜화해서 일별 집계
 * - since는 "KST 자정" 기준 UTC Date (startOfDayKST로 넣어야 정확)
 * - 출력 키(d)는 'YYYY-MM-DD' (KST 기준)
 */
async function dailyCountPostgres(
  table: DailyTable,
  sinceKstStartUtc: Date,
  opts?: DailyCountOpts
) {
  const t = `"${table}"`;

  const extraWhere =
    table === "Issue" && opts?.issueRegisteredOnly
      ? ` AND "status" <> 'SUGGESTED'`
      : ``;

  const rows = await prisma.$queryRawUnsafe<Array<{ d: string; c: number }>>(
    `
    SELECT to_char((("createdAt" + interval '9 hours')::date), 'YYYY-MM-DD') AS d,
           COUNT(*)::int AS c
    FROM ${t}
    WHERE "createdAt" >= $1${extraWhere}
    GROUP BY 1
    ORDER BY 1 ASC
    `,
    sinceKstStartUtc
  );

  const map = new Map<string, number>();
  rows.forEach((r) => map.set(r.d, Number(r.c)));
  return map;
}

/**
 * ✅ PageView dayKey는 이미 KST YYYY-MM-DD
 * - issue 조회수는 "등록된 이슈"만 집계하려면 Issue join + status 필터 필요
 * - parentType(enum) 비교 문제 방지: ::text 캐스팅
 */
async function dailyViewsMapRegisteredOnly(
  parentType: "issue" | "agenda" | "clipIssue",
  sinceKstStartUtc: Date
) {
  const sinceKey = dayKeyKST(sinceKstStartUtc);

  if (parentType === "issue") {
    const rows = await prisma.$queryRawUnsafe<Array<{ d: string; c: number }>>(
      `
      SELECT pv."dayKey" AS d, COUNT(*)::int AS c
      FROM "PageView" pv
      JOIN "Issue" i ON i.id = pv."parentId"
      WHERE (pv."parentType"::text) = $1
        AND pv."dayKey" >= $2
        AND i."status" <> 'SUGGESTED'
      GROUP BY pv."dayKey"
      ORDER BY d ASC
      `,
      parentType,
      sinceKey
    );
    const map = new Map<string, number>();
    rows.forEach((r) => map.set(r.d, Number(r.c)));
    return map;
  }

  const rows = await prisma.$queryRawUnsafe<Array<{ d: string; c: number }>>(
    `
    SELECT "dayKey" AS d, COUNT(*)::int AS c
    FROM "PageView"
    WHERE ("parentType"::text) = $1 AND "dayKey" >= $2
    GROUP BY "dayKey"
    ORDER BY d ASC
    `,
    parentType,
    sinceKey
  );
  const map = new Map<string, number>();
  rows.forEach((r) => map.set(r.d, Number(r.c)));
  return map;
}

/** ✅ 오늘 issue 조회수(등록된 이슈만) */
async function issueViewsTodayRegisteredOnly(todayKey: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ c: number }>>(
    `
    SELECT COUNT(*)::int AS c
    FROM "PageView" pv
    JOIN "Issue" i ON i.id = pv."parentId"
    WHERE (pv."parentType"::text) = 'issue'
      AND pv."dayKey" = $1
      AND i."status" <> 'SUGGESTED'
    `,
    todayKey
  );
  return Number(rows?.[0]?.c ?? 0);
}

/** ✅ 오늘 clipIssue 조회수 */
async function clipIssueViewsToday(todayKey: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ c: number }>>(
    `
    SELECT COUNT(*)::int AS c
    FROM "PageView"
    WHERE (("parentType"::text) = 'clipIssue')
      AND "dayKey" = $1
    `,
    todayKey
  );
  return Number(rows?.[0]?.c ?? 0);
}

/**
 * GET /api/admin/metrics?period=7|30|...
 */
router.get(
  "/admin/metrics",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    try {
      const rawPeriod = Number(req.query.period ?? 30);
      const period = Math.min(
        Math.max(Number.isFinite(rawPeriod) && rawPeriod > 0 ? rawPeriod : 30, 1),
        90
      );

      // ✅ KST 기준
      const todayStartKstUtc = startOfDayKST(new Date());
      const last1d = new Date(Date.now() - 24 * 60 * 60 * 1000); // "최근 24h"는 굳이 KST 자정 필요 없음
      const last7dKstStartUtc = daysAgoKST(7);
      const last30dKstStartUtc = daysAgoKST(30);

      // ✅ "등록된 이슈" 기준: status != SUGGESTED
      const issueRegisteredWhere = { status: { not: "SUGGESTED" as any } };

      /* ── 총계 / 금일 ───────────────────────────────── */
      const [
        issuesTotal,
        agendasTotal,
        issueCommentsTotal,
        agendaCommentsTotal,
        clipIssuesTotal,
        clipIssueCommentsTotal,

        issuesToday,
        agendasToday,
        issueCommentsToday,
        agendaCommentsToday,
        clipIssuesToday,
        clipIssueCommentsToday,
      ] = await Promise.all([
        safe("issuesTotal", () => prisma.issue.count({ where: issueRegisteredWhere }), 0),
        safe("agendasTotal", () => prisma.agenda.count(), 0),
        safe("issueCommentsTotal", () => prisma.issueComment.count(), 0),
        safe("agendaCommentsTotal", () => prisma.agendaComment.count(), 0),
        safe("clipIssuesTotal", () => prisma.clipIssue.count(), 0),
        safe("clipIssueCommentsTotal", () => prisma.clipIssueComment.count(), 0),

        // ✅ "오늘"은 KST 자정 기준으로 createdAt 필터
        safe(
          "issuesToday",
          () => prisma.issue.count({ where: { ...issueRegisteredWhere, createdAt: { gte: todayStartKstUtc } } }),
          0
        ),
        safe("agendasToday", () => prisma.agenda.count({ where: { createdAt: { gte: todayStartKstUtc } } }), 0),
        safe("issueCommentsToday", () => prisma.issueComment.count({ where: { createdAt: { gte: todayStartKstUtc } } }), 0),
        safe("agendaCommentsToday", () => prisma.agendaComment.count({ where: { createdAt: { gte: todayStartKstUtc } } }), 0),
        safe("clipIssuesToday", () => prisma.clipIssue.count({ where: { createdAt: { gte: todayStartKstUtc } } }), 0),
        safe("clipIssueCommentsToday", () => prisma.clipIssueComment.count({ where: { createdAt: { gte: todayStartKstUtc } } }), 0),
      ]);

      /* ── DAU / MAU / 7일 활성 ────────────────────── */
      const [
        dauA, dauAC, dauIC, dauV, dauAL, dauCL, dauICL,
        mauA, mauAC, mauIC, mauV, mauAL, mauCL, mauICL,
        actA, actAC, actIC, actV, actAL, actCL, actICL,
      ] = await Promise.all([
        // DAU (최근 24h)
        safe("dauA", async () => new Set((await prisma.agenda.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauAC", async () => new Set((await prisma.agendaComment.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauIC", async () => new Set((await prisma.issueComment.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauV", async () => new Set((await prisma.vote.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauAL", async () => new Set((await prisma.agendaLike.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauCL", async () => new Set((await prisma.commentLike.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauICL", async () => new Set((await prisma.issueCommentLike.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),

        // MAU (KST 기준 30일 범위는 "시작 자정"을 정확히)
        safe("mauA", async () => new Set((await prisma.agenda.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauAC", async () => new Set((await prisma.agendaComment.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauIC", async () => new Set((await prisma.issueComment.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauV", async () => new Set((await prisma.vote.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauAL", async () => new Set((await prisma.agendaLike.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauCL", async () => new Set((await prisma.commentLike.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauICL", async () => new Set((await prisma.issueCommentLike.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),

        // active 7d (KST 기준)
        safe("actA", async () => new Set((await prisma.agenda.findMany({ where: { createdAt: { gte: last7dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("actAC", async () => new Set((await prisma.agendaComment.findMany({ where: { createdAt: { gte: last7dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("actIC", async () => new Set((await prisma.issueComment.findMany({ where: { createdAt: { gte: last7dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("actV", async () => new Set((await prisma.vote.findMany({ where: { createdAt: { gte: last7dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("actAL", async () => new Set((await prisma.agendaLike.findMany({ where: { createdAt: { gte: last7dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("actCL", async () => new Set((await prisma.commentLike.findMany({ where: { createdAt: { gte: last7dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("actICL", async () => new Set((await prisma.issueCommentLike.findMany({ where: { createdAt: { gte: last7dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
      ]);

      const dau = union(dauA, dauAC, dauIC, dauV, dauAL, dauCL, dauICL).size;
      const mau = union(mauA, mauAC, mauIC, mauV, mauAL, mauCL, mauICL).size;
      const active7d = union(actA, actAC, actIC, actV, actAL, actCL, actICL).size;

      /* ── CTI 평균/분포 ───────────────────────────── */
      const usersWithCTI = await safe(
        "usersWithCTI",
        async () => {
          return prisma.user.findMany({
            select: { ctiType: true, ctiScores: true },
            where: {
              AND: [
                { ctiScores: { not: (Prisma as any).DbNull } as any },
                { ctiScores: { not: (Prisma as any).JsonNull } as any },
              ],
            },
            take: 10000,
          });
        },
        [] as Array<{ ctiType: string | null; ctiScores: any }>
      );

      let avgScores: { E: number; S: number; P: number } | null = null;
      const typeDist: Record<string, number> = {};
      if (usersWithCTI.length) {
        let e = 0, s = 0, p = 0, n = 0;
        for (const u of usersWithCTI) {
          const sc = u.ctiScores as any;
          if (sc && typeof sc === "object" && typeof sc.E === "number" && typeof sc.S === "number" && typeof sc.P === "number") {
            e += sc.E;
            s += sc.S;
            p += sc.P;
            n++;
          }
          const t = u.ctiType ?? "UNKNOWN";
          typeDist[t] = (typeDist[t] ?? 0) + 1;
        }
        if (n > 0) avgScores = { E: +(e / n).toFixed(2), S: +(s / n).toFixed(2), P: +(p / n).toFixed(2) };
      }

      /* ── 일일 추이(최근 N일, KST 기준) ───────────── */
      const days = lastNDatesKST(period);
      const sinceKstStartUtc = daysAgoKST(period - 1);

      const [mIssue, mAgenda, mIssueC, mAgendaC, mIssueV, mAgendaV, mClip, mClipC, mClipV] =
        await Promise.all([
          dailyCountPostgres("Issue", sinceKstStartUtc, { issueRegisteredOnly: true }),
          dailyCountPostgres("Agenda", sinceKstStartUtc),
          dailyCountPostgres("IssueComment", sinceKstStartUtc),
          dailyCountPostgres("AgendaComment", sinceKstStartUtc),
          dailyViewsMapRegisteredOnly("issue", sinceKstStartUtc),
          dailyViewsMapRegisteredOnly("agenda", sinceKstStartUtc),
          dailyCountPostgres("ClipIssue", sinceKstStartUtc),
          dailyCountPostgres("ClipIssueComment", sinceKstStartUtc),
          dailyViewsMapRegisteredOnly("clipIssue", sinceKstStartUtc),
        ]);

      const todayKey = dayKeyKST(new Date());

      const [issuesViewsToday, agendasViewsToday, clipIssuesViewsToday] =
        await Promise.all([
          safe("issuesViewsToday", () => issueViewsTodayRegisteredOnly(todayKey), 0),
          safe("agendasViewsToday", () => prisma.pageView.count({ where: { parentType: "agenda", dayKey: todayKey } }), 0),
          safe("clipIssuesViewsToday", () => clipIssueViewsToday(todayKey), 0),
        ]);

      const timeseries = {
        lastNDays: days.map((d) => ({
          date: d,
          issues: mIssue.get(d) ?? 0,
          issueViews: mIssueV.get(d) ?? 0,
          issueComments: mIssueC.get(d) ?? 0,
          agendas: mAgenda.get(d) ?? 0,
          agendaViews: mAgendaV.get(d) ?? 0,
          agendaComments: mAgendaC.get(d) ?? 0,
          clipIssues: mClip.get(d) ?? 0,
          clipIssueViews: mClipV.get(d) ?? 0,
          clipIssueComments: mClipC.get(d) ?? 0,
        })),
        period,
      };

      return res.json({
        ok: true,
        data: {
          issues: {
            total: issuesTotal,
            today: issuesToday,
            viewsToday: issuesViewsToday,
            commentsTotal: issueCommentsTotal,
            commentsToday: issueCommentsToday,
          },
          clipIssues: {
            total: clipIssuesTotal,
            today: clipIssuesToday,
            viewsToday: clipIssuesViewsToday,
            commentsTotal: clipIssueCommentsTotal,
            commentsToday: clipIssueCommentsToday,
          },
          agendas: {
            total: agendasTotal,
            today: agendasToday,
            viewsToday: agendasViewsToday,
            commentsTotal: agendaCommentsTotal,
            commentsToday: agendaCommentsToday,
          },
          comments: {
            agenda: agendaCommentsTotal,
            issue: issueCommentsTotal,
          },
          users: { dau, mau, active7d },
          cti: { avgScores, typeDist },
          timeseries,
        },
      });
    } catch (err) {
      console.error("[admin/metrics] ERROR:", err);
      return res.status(500).json({
        ok: false,
        error: "ADMIN_METRICS_FAILED",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
);

export default router;
