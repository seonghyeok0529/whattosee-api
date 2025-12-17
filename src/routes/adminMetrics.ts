// src/routes/adminMetrics.ts
import { Router } from "express";
import type { Request, Response } from "express";
import { Prisma, PrismaClient } from "@prisma/client";
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
function toYMD(d: Date) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
function dayKeyKST(d = new Date()) {
  const kstMs = d.getTime() + 9 * 60 * 60 * 1000;
  return new Date(kstMs).toISOString().slice(0, 10);
}
function lastNDates(n: number) {
  const out: string[] = [];
  const today = startOfDay();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    // ⚠️ 기존 toYMD는 UTC 기준이므로, KST 기준 일자 통일을 위해 dayKeyKST 사용
    out.push(dayKeyKST(d));
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

/**
 * ✅ Postgres용 일별 카운트
 * - createdAt을 KST 기준으로 날짜를 뽑아내기 위해 +9 hours 적용
 * - Prisma.sql 바인딩 사용 (SQLite의 ? 바인딩 / date() 함수 제거)
 */
async function dailyCountPostgres(table: DailyTable, since: Date) {
  const tableSql = Prisma.raw(`"${table}"`);
  const sinceDate = startOfDay(since);

  const rows = await prisma.$queryRaw<Array<{ d: string; c: number }>>(
    Prisma.sql`
      SELECT to_char((("createdAt" + interval '9 hours')::date), 'YYYY-MM-DD') AS d,
             COUNT(*)::int AS c
      FROM ${tableSql}
      WHERE "createdAt" >= ${sinceDate}
      GROUP BY 1
      ORDER BY 1 ASC
    `
  );

  const map = new Map<string, number>();
  rows.forEach((r) => map.set(r.d, Number(r.c)));
  return map;
}

/**
 * ✅ PageView는 이미 dayKey가 KST 기준 YYYY-MM-DD로 들어가므로 그대로 집계
 */
async function dailyViewsMap(parentType: "issue" | "agenda", since: Date) {
  const t = Prisma.raw(`"PageView"`);
  const sinceKey = dayKeyKST(startOfDay(since));

  const rows = await prisma.$queryRaw<Array<{ d: string; c: number }>>(
    Prisma.sql`
      SELECT "dayKey" AS d, COUNT(*)::int AS c
      FROM ${t}
      WHERE "parentType" = ${parentType} AND "dayKey" >= ${sinceKey}
      GROUP BY "dayKey"
      ORDER BY d ASC
    `
  );

  const map = new Map<string, number>();
  rows.forEach((r) => map.set(r.d, Number(r.c)));
  return map;
}

/**
 * GET /api/admin/metrics?period=7|14|30|90
 * 대시보드용 요약 + 시계열 데이터
 */
router.get(
  "/admin/metrics",
  requireAuth,
  adminAuth,
  async (req: Request, res: Response) => {
    // period 쿼리 파라미터 (기본 30일, 1~90일 사이로 제한)
    const rawPeriod = Number(req.query.period ?? 30);
    const period = Math.min(
      Math.max(Number.isFinite(rawPeriod) && rawPeriod > 0 ? rawPeriod : 30, 1),
      90
    );

    const todayStart = startOfDay();
    const last1d = daysAgo(1);
    const last7d = daysAgo(7);
    const last30d = daysAgo(30); // DAU/MAU 계산용은 그대로 유지

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
      safe(() => prisma.issue.count(), 0),
      safe(() => prisma.agenda.count(), 0),
      safe(() => prisma.issueComment.count(), 0),
      safe(() => prisma.agendaComment.count(), 0),

      safe(() => prisma.issue.count({ where: { createdAt: { gte: todayStart } } }), 0),
      safe(() => prisma.agenda.count({ where: { createdAt: { gte: todayStart } } }), 0),
      safe(() => prisma.issueComment.count({ where: { createdAt: { gte: todayStart } } }), 0),
      safe(() => prisma.agendaComment.count({ where: { createdAt: { gte: todayStart } } }), 0),
    ]);

    /* ── DAU / MAU / 7일 활성 ────────────────────── */
    const [
      dauA,
      dauAC,
      dauIC,
      dauV,
      dauAL,
      dauCL,
      dauICL,
      mauA,
      mauAC,
      mauIC,
      mauV,
      mauAL,
      mauCL,
      mauICL,
      actA,
      actAC,
      actIC,
      actV,
      actAL,
      actCL,
      actICL,
    ] = await Promise.all([
      // DAU (24h)
      safe(
        async () =>
          new Set(
            (
              await prisma.agenda.findMany({
                where: { createdAt: { gte: last1d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.agendaComment.findMany({
                where: { createdAt: { gte: last1d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.issueComment.findMany({
                where: { createdAt: { gte: last1d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.vote.findMany({
                where: { createdAt: { gte: last1d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.agendaLike.findMany({
                where: { createdAt: { gte: last1d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.commentLike.findMany({
                where: { createdAt: { gte: last1d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.issueCommentLike.findMany({
                where: { createdAt: { gte: last1d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),

      // MAU (30d)
      safe(
        async () =>
          new Set(
            (
              await prisma.agenda.findMany({
                where: { createdAt: { gte: last30d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.agendaComment.findMany({
                where: { createdAt: { gte: last30d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.issueComment.findMany({
                where: { createdAt: { gte: last30d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.vote.findMany({
                where: { createdAt: { gte: last30d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.agendaLike.findMany({
                where: { createdAt: { gte: last30d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.commentLike.findMany({
                where: { createdAt: { gte: last30d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.issueCommentLike.findMany({
                where: { createdAt: { gte: last30d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),

      // active 7d
      safe(
        async () =>
          new Set(
            (
              await prisma.agenda.findMany({
                where: { createdAt: { gte: last7d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.agendaComment.findMany({
                where: { createdAt: { gte: last7d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.issueComment.findMany({
                where: { createdAt: { gte: last7d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.vote.findMany({
                where: { createdAt: { gte: last7d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.agendaLike.findMany({
                where: { createdAt: { gte: last7d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.commentLike.findMany({
                where: { createdAt: { gte: last7d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
      safe(
        async () =>
          new Set(
            (
              await prisma.issueCommentLike.findMany({
                where: { createdAt: { gte: last7d } },
                select: { userId: true },
              })
            )
              .map((r) => r.userId)
              .filter(Boolean) as string[]
          ),
        new Set<string>()
      ),
    ]);

    const dau = union(dauA, dauAC, dauIC, dauV, dauAL, dauCL, dauICL).size;
    const mau = union(mauA, mauAC, mauIC, mauV, mauAL, mauCL, mauICL).size;
    const active7d = union(actA, actAC, actIC, actV, actAL, actCL, actICL).size;

    /* ── CTI 평균/분포 ───────────────────────────── */
    const usersWithCTI = await safe(
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
      let e = 0,
        s = 0,
        p = 0,
        n = 0;
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
        dailyCountPostgres("Issue", since),
        dailyCountPostgres("Agenda", since),
        dailyCountPostgres("IssueComment", since),
        dailyCountPostgres("AgendaComment", since),
        dailyViewsMap("issue", since),
        dailyViewsMap("agenda", since),
      ]);

    const todayKey = dayKeyKST();
    const [issuesViewsToday, agendasViewsToday] = await Promise.all([
      safe(
        () => prisma.pageView.count({ where: { parentType: "issue", dayKey: todayKey } }),
        0
      ),
      safe(
        () => prisma.pageView.count({ where: { parentType: "agenda", dayKey: todayKey } }),
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
          total: issuesTotal,
          today: issuesToday,
          viewsToday: issuesViewsToday,
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
  }
);

export default router;
