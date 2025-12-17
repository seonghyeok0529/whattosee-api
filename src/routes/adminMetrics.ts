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
───────────────────────────────────────────── */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function startOfDayKST(d = new Date()) {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  k.setUTCHours(0, 0, 0, 0);
  return new Date(k.getTime() - KST_OFFSET_MS);
}

function endOfDayKST(d = new Date()) {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  k.setUTCHours(23, 59, 59, 999);
  return new Date(k.getTime() - KST_OFFSET_MS);
}

function daysAgoKST(n: number) {
  const todayStart = startOfDayKST(new Date());
  const d = new Date(todayStart);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function dayKeyKST(d = new Date()) {
  const kstMs = d.getTime() + KST_OFFSET_MS;
  return new Date(kstMs).toISOString().slice(0, 10);
}

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
  issueRegisteredOnly?: boolean;
};

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

/* ─────────────────────────────────────────────
   ✅ 기간 파싱 (period or dateFrom/dateTo)
   - dateFrom/dateTo: 'YYYY-MM-DD' (KST day)
───────────────────────────────────────────── */
function parseYMD(ymd?: unknown) {
  if (typeof ymd !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return ymd;
}

function kstRangeFromYMD(dateFromYMD: string, dateToYMD: string) {
  // KST 기준 해당 날짜 자정을 UTC Date로 만들기
  const from = startOfDayKST(new Date(`${dateFromYMD}T00:00:00+09:00`));
  const to = endOfDayKST(new Date(`${dateToYMD}T00:00:00+09:00`));
  return { from, to };
}

/* ─────────────────────────────────────────────
   ✅ 키워드 집계 (가벼운 토큰화 + 불용어 제거)
───────────────────────────────────────────── */
const KO_STOPWORDS = new Set([
  "그리고","하지만","그러나","또한","또","때문","통해","대해","대한","관련","등",
  "이번","지난","오늘","내일","어제","현재","이날","당시","최근","앞서","이후",
  "기자","뉴스","속보","단독","영상","공개","발언","논란","정리","요약","총정리",
  "것","수","등의","및","에서","으로","에게","까지","부터","보다","처럼","대한",
  "하는","했다","한다","됐다","된다","있다","없다","위해","중","더","또",
]);

const EN_STOPWORDS = new Set([
  "the","a","an","and","or","but","to","of","in","on","for","with","as","by","at",
  "is","are","was","were","be","been","it","this","that","these","those",
]);

function normalizeText(s: string) {
  return s
    .replace(/&quot;|&#39;|&amp;|&lt;|&gt;/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[“”‘’]/g, '"')
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // 문자/숫자/공백만 남김
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string) {
  const norm = normalizeText(s).toLowerCase();
  if (!norm) return [];
  const parts = norm.split(" ").filter(Boolean);

  const out: string[] = [];
  for (const p of parts) {
    // 너무 짧은 토큰 제거
    if (p.length <= 1) continue;

    // 숫자만 있는 토큰 제거
    if (/^\d+$/.test(p)) continue;

    // 한글 조사/어미 성격의 흔한 짧은 것 제거(휴리스틱)
    // (형태소 분석 대신 "실무형" 필터)
    if (p.length === 2 && (p.endsWith("은") || p.endsWith("는") || p.endsWith("이") || p.endsWith("가"))) continue;

    if (KO_STOPWORDS.has(p)) continue;
    if (EN_STOPWORDS.has(p)) continue;

    out.push(p);
  }
  return out;
}

type KeywordItem = { keyword: string; count: number };

function topNFromCounter(counter: Map<string, number>, n: number): KeywordItem[] {
  const arr: KeywordItem[] = [];
  for (const [keyword, count] of counter.entries()) arr.push({ keyword, count });
  arr.sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword));
  return arr.slice(0, n);
}

async function computeTopKeywords(params: {
  from: Date;
  to: Date;
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 30, 5), 100);

  // ✅ 언론 이슈 키워드
  // - status != SUGGESTED
  // - createdAt 기준 (대시보드 “등록 추이”와 일관)
  const issues = await prisma.issue.findMany({
    where: {
      status: { not: "SUGGESTED" as any },
      createdAt: { gte: params.from, lte: params.to },
    },
    select: {
      title: true,
      summary: true,
      body: true,
      sources: { select: { title: true, outlet: true } },
    },
    take: 5000, // ✅ 안전장치 (폭주 방지)
    orderBy: { createdAt: "desc" },
  });

  const issueCounter = new Map<string, number>();
  for (const it of issues) {
    const buf: string[] = [];
    if (it.title) buf.push(it.title);
    if (it.summary) buf.push(it.summary);
    if (it.body) buf.push(it.body);
    for (const s of it.sources ?? []) {
      if (s.title) buf.push(s.title);
      // outlet까지 토큰에 넣고 싶으면 아래 주석 해제
      // if (s.outlet) buf.push(s.outlet);
    }
    const tokens = tokenize(buf.join(" "));
    for (const t of tokens) issueCounter.set(t, (issueCounter.get(t) ?? 0) + 1);
  }

  // ✅ 클립 이슈 키워드
  // - ClipIssue.createdAt 기준
  // - ClipIssue + 연결 RawClip(title/description/text)까지 포함
  const clipIssues = await prisma.clipIssue.findMany({
    where: { createdAt: { gte: params.from, lte: params.to } },
    select: {
      title: true,
      description: true,
      aiSummary: true,
      clips: {
        select: {
          rawClip: { select: { title: true, description: true, text: true, channel: true } },
        },
      },
    },
    take: 3000,
    orderBy: { createdAt: "desc" },
  });

  const clipCounter = new Map<string, number>();
  for (const ci of clipIssues) {
    const buf: string[] = [];
    if (ci.title) buf.push(ci.title);
    if (ci.description) buf.push(ci.description);
    if (ci.aiSummary) buf.push(ci.aiSummary);

    for (const link of ci.clips ?? []) {
      const rc = link.rawClip;
      if (!rc) continue;
      if (rc.title) buf.push(rc.title);
      if (rc.description) buf.push(rc.description);
      if (rc.text) buf.push(rc.text);
      // channel까지 포함하고 싶으면 아래 주석 해제
      // if (rc.channel) buf.push(rc.channel);
    }

    const tokens = tokenize(buf.join(" "));
    for (const t of tokens) clipCounter.set(t, (clipCounter.get(t) ?? 0) + 1);
  }

  return {
    issues: topNFromCounter(issueCounter, limit),
    clipIssues: topNFromCounter(clipCounter, limit),
    meta: {
      from: params.from.toISOString(),
      to: params.to.toISOString(),
      issueDocs: issues.length,
      clipIssueDocs: clipIssues.length,
      limit,
    },
  };
}

/**
 * GET /api/admin/metrics?period=7|30|...
 * GET /api/admin/metrics?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
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

      // ✅ range 우선순위: dateFrom/dateTo > period
      const qFrom = parseYMD(req.query.dateFrom);
      const qTo = parseYMD(req.query.dateTo);

      let rangeFromKstUtc: Date;
      let rangeToKstUtc: Date;

      if (qFrom && qTo) {
        const r = kstRangeFromYMD(qFrom, qTo);
        rangeFromKstUtc = r.from;
        rangeToKstUtc = r.to;
      } else {
        // period 기준: "오늘 포함 최근 N일"
        const from = daysAgoKST(period - 1);
        rangeFromKstUtc = from;
        rangeToKstUtc = endOfDayKST(new Date());
      }

      // ✅ KST 기준
      const todayStartKstUtc = startOfDayKST(new Date());
      const last1d = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const last7dKstStartUtc = daysAgoKST(7);
      const last30dKstStartUtc = daysAgoKST(30);

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
        safe("dauA", async () => new Set((await prisma.agenda.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauAC", async () => new Set((await prisma.agendaComment.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauIC", async () => new Set((await prisma.issueComment.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauV", async () => new Set((await prisma.vote.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauAL", async () => new Set((await prisma.agendaLike.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauCL", async () => new Set((await prisma.commentLike.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("dauICL", async () => new Set((await prisma.issueCommentLike.findMany({ where: { createdAt: { gte: last1d } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),

        safe("mauA", async () => new Set((await prisma.agenda.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauAC", async () => new Set((await prisma.agendaComment.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauIC", async () => new Set((await prisma.issueComment.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauV", async () => new Set((await prisma.vote.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauAL", async () => new Set((await prisma.agendaLike.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauCL", async () => new Set((await prisma.commentLike.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),
        safe("mauICL", async () => new Set((await prisma.issueCommentLike.findMany({ where: { createdAt: { gte: last30dKstStartUtc } }, select: { userId: true } })).map(r => r.userId).filter(Boolean) as string[]), new Set<string>()),

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

      /* ── ✅ 키워드 Top-N (선택 기간/date range 기준) ── */
      const topKeywords = await safe(
        "topKeywords",
        () => computeTopKeywords({ from: rangeFromKstUtc, to: rangeToKstUtc, limit: 30 }),
        { issues: [], clipIssues: [], meta: { from: rangeFromKstUtc.toISOString(), to: rangeToKstUtc.toISOString(), issueDocs: 0, clipIssueDocs: 0, limit: 30 } }
      );

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

          // ✅ 신규 필드
          topKeywords,

          // ✅ 어떤 range로 계산했는지 프론트에서 표시 가능
          keywordRange: {
            from: rangeFromKstUtc.toISOString(),
            to: rangeToKstUtc.toISOString(),
            mode: qFrom && qTo ? "dateRange" : "period",
            period: qFrom && qTo ? null : period,
            dateFrom: qFrom ?? null,
            dateTo: qTo ?? null,
          },
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
