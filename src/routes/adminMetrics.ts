// src/routes/adminMetrics.ts
import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { adminAuth } from "../middleware/adminAuth";

const prisma = new PrismaClient();
const router = Router();

/* ─────────────────────────────────────────────
   날짜 유틸 (KST 일관성 유지)
───────────────────────────────────────────── */
function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function dayKeyKST(d = new Date()) {
  const kstMs = d.getTime() + 9 * 60 * 60 * 1000;
  return new Date(kstMs).toISOString().slice(0, 10); // YYYY-MM-DD
}
function lastNDates(n: number) {
  const out: string[] = [];
  const today = startOfDay();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(dayKeyKST(d)); // ✅ KST 기준 dayKey
  }
  return out;
}

async function safe<T>(fn: () => Promise<T>, fb: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fb;
  }
}
function union<T>(...sets: Set<T>[]) {
  const out = new Set<T>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}

type DailyTable = "Issue" | "Agenda" | "IssueComment" | "AgendaComment";

type DailyCountOpts = {
  /** ✅ 등록된 이슈만 집계: Issue.status != 'SUGGESTED' */
  issueRegisteredOnly?: boolean;
};

/**
 * ✅ Postgres: createdAt을 KST(+9h)로 날짜화해서 일별 집계
 * - since는 DateTime 비교 (UTC 기준으로 DB에 저장되어 있을 것)
 * - 출력 키(d)는 'YYYY-MM-DD' (KST 기준)
 */
async function dailyCountPostgres(
  table: DailyTable,
  since: Date,
  opts?: DailyCountOpts
) {
  const t = `"${table}"`;
  const sinceDate = startOfDay(since);

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
    sinceDate
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
  parentType: "issue" | "agenda",
  since: Date
) {
  const sinceKey = dayKeyKST(startOfDay(since));

  // issue: 등록된 이슈만 (status != SUGGESTED)
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

  // agenda: 그대로
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

/**
 * ✅ 오늘 issue 조회수(등록된 이슈만)
 */
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
        Math.max(
          Number.isFinite(rawPeriod) && rawPeriod > 0 ? rawPeriod : 30,
          1
        ),
        90
      );

      const todayStart = startOfDay();
      const last1d = daysAgo(1);
      const last7d = daysAgo(7);
      const last30d = daysAgo(30);

      // ✅ "등록된 이슈" 기준: status != SUGGESTED
      const issueRegisteredWhere = { status: { not: "SUGGESTED" as any } };

      /* ── 총계 / 금일 ───────────────────────────────── */
      const [
        issuesTotal,
        agendasTotal,
        issueCommentsTotal,
        agendaCommentsTotal,
        issuesToday,
        agendasToday,
        issueCommentsToday,
        agendaCommentsToday,
      ] = await Promise.all([
        // ✅ 등록된 이슈만
        safe(() => prisma.issue.count({ where: issueRegisteredWhere }), 0),
        safe(() => prisma.agenda.count(), 0),
        safe(() => prisma.issueComment.count(), 0),
        safe(() => prisma.agendaComment.count(), 0),

        // ✅ 등록된 이슈 + 오늘
        safe(
          () =>
            prisma.issue.count({
              where: { ...issueRegisteredWhere, createdAt: { gte: todayStart } },
            }),
          0
        ),
        safe(() => prisma.agenda.count({ where: { createdAt: { gte: todayStart } } }), 0),
        safe(() => prisma.issueComment.count({ where: { createdAt: { gte: todayStart } } }), 0),
        safe(() => prisma.agendaComment.count({ where: { createdAt: { gte: todayStart } } }), 0),
      ]);

      /* ── DAU / MAU / 7일 활성 ────────────────────── */
      const [
        dauA, dauAC, dauIC, dauV, dauAL, dauCL, dauICL,
        mauA, mauAC, mauIC, mauV, mauAL, mauCL, mauICL,
        actA, actAC, actIC, actV, actAL, actCL, actICL,
      ] = await Promise.all([
        // DAU (24h)
        safe(async () => new Set((await prisma.agenda.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.agendaComment.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.issueComment.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.vote.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.agendaLike.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.commentLike.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.issueCommentLike.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),

        // MAU (30d)
        safe(async () => new Set((await prisma.agenda.findMany({ where: { createdAt: { gte: last30d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.agendaComment.findMany({ where: { createdAt: { gte: last30d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.issueComment.findMany({ where: { createdAt: { gte: last30d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.vote.findMany({ where: { createdAt: { gte: last30d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.agendaLike.findMany({ where: { createdAt: { gte: last30d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.commentLike.findMany({ where: { createdAt: { gte: last30d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.issueCommentLike.findMany({ where: { createdAt: { gte: last30d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),

        // active 7d
        safe(async () => new Set((await prisma.agenda.findMany({ where: { createdAt: { gte: last7d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.agendaComment.findMany({ where: { createdAt: { gte: last7d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.issueComment.findMany({ where: { createdAt: { gte: last7d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.vote.findMany({ where: { createdAt: { gte: last7d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.agendaLike.findMany({ where: { createdAt: { gte: last7d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.commentLike.findMany({ where: { createdAt: { gte: last7d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe(async () => new Set((await prisma.issueCommentLike.findMany({ where: { createdAt: { gte: last7d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
      ]);

      const dau = union(dauA, dauAC, dauIC, dauV, dauAL, dauCL, dauICL).size;
      const mau = union(mauA, mauAC, mauIC, mauV, mauAL, mauCL, mauICL).size;
      const active7d = union(actA, actAC, actIC, actV, actAL, actCL, actICL).size;

      /* ── CTI 평균/분포 ───────────────────────────── */
      const usersWithCTI = await safe(async () => {
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
      }, [] as Array<{ ctiType: string | null; ctiScores: any }>);

      let avgScores: { E: number; S: number; P: number } | null = null;
      const typeDist: Record<string, number> = {};
      if (usersWithCTI.length) {
        let e = 0, s = 0, p = 0, n = 0;
        for (const u of usersWithCTI) {
          const sc = u.ctiScores as any;
          if (
            sc &&
            typeof sc === "object" &&
            typeof sc.E === "number" &&
            typeof sc.S === "number" &&
            typeof sc.P === "number"
          ) {
            e += sc.E;
            s += sc.S;
            p += sc.P;
            n++;
          }
          const t = u.ctiType ?? "UNKNOWN";
          typeDist[t] = (typeDist[t] ?? 0) + 1;
        }
        if (n > 0)
          avgScores = {
            E: +(e / n).toFixed(2),
            S: +(s / n).toFixed(2),
            P: +(p / n).toFixed(2),
          };
      }

      /* ── 일일 추이(최근 N일) ────────────────────── */
      const days = lastNDates(period);
      const since = daysAgo(period - 1);

      const [mIssue, mAgenda, mIssueC, mAgendaC, mIssueV, mAgendaV] =
        await Promise.all([
          // ✅ 등록된 이슈만
          dailyCountPostgres("Issue", since, { issueRegisteredOnly: true }),
          dailyCountPostgres("Agenda", since),
          dailyCountPostgres("IssueComment", since),
          dailyCountPostgres("AgendaComment", since),
          // ✅ 등록된 이슈 조회수만
          dailyViewsMapRegisteredOnly("issue", since),
          dailyViewsMapRegisteredOnly("agenda", since),
        ]);

      const todayKey = dayKeyKST();

      const [issuesViewsToday, agendasViewsToday] = await Promise.all([
        safe(() => issueViewsTodayRegisteredOnly(todayKey), 0),
        safe(
          () =>
            prisma.pageView.count({
              where: { parentType: "agenda", dayKey: todayKey },
            }),
          0
        ),
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
        })),
        period,
      };

      return res.json({
        ok: true,
        data: {
          issues: {
            total: issuesTotal, // ✅ 등록된 이슈 총계
            today: issuesToday, // ✅ 등록된 이슈 오늘 생성
            viewsToday: issuesViewsToday, // ✅ 등록된 이슈 오늘 조회
            commentsTotal: issueCommentsTotal,
            commentsToday: issueCommentsToday,
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
