// src/routes/search.ts
import { Router, type Request, type Response } from "express";
import prisma from "../lib/prisma.js";

export const searchRouter = Router();

type Scope = "media" | "user" | "all";

/** 프런트가 기대하는 Issue 카드용 DTO */
interface IssueDTO {
  id: string;
  title: string;
  summary: string | null;
  tags: any;
  createdAt: Date;
  updatedAt: Date;
  sources: { outlet: string | null; side: string | null }[];
}

/** 프런트가 기대하는 Agenda 카드용 DTO */
interface AgendaDTO {
  id: string;
  title: string;
  content: string;
  tags: any;
  likesCount: number;
  commentCount: number;
  createdAt: Date;
}

/** raw 쿼리에서 공통적으로 쓰는 id 한 개짜리 행 */
interface IdRow { id: string }

searchRouter.get("/", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  const scope = (String(req.query.scope ?? "all") as Scope);
  if (!q) return res.json({ issues: [] as IssueDTO[], agendas: [] as AgendaDTO[] });

  try {
    /* =========================
     * 1) 이슈 검색 (Issue)
     *   - 제목/요약/본문 LIKE NOCASE
     *   - 태그 json_each LIKE NOCASE
     *   - 출처(Source) 제목/매체 LIKE NOCASE
     * ========================= */
    const issuesPromise: Promise<IssueDTO[] | []> =
      scope !== "user"
        ? (async () => {
            // 1-1. 제목/요약/본문
            const textRows = await prisma.$queryRaw<IdRow[]>`
              SELECT id
              FROM Issue
              WHERE (title   LIKE '%' || ${q} || '%' COLLATE NOCASE)
                 OR (summary LIKE '%' || ${q} || '%' COLLATE NOCASE)
                 OR (body    LIKE '%' || ${q} || '%' COLLATE NOCASE)
            `;

            // 1-2. 태그
            const tagRows = await prisma.$queryRaw<IdRow[]>`
              SELECT DISTINCT i.id
              FROM Issue AS i, json_each(i.tags) AS t
              WHERE CAST(t.value AS TEXT) LIKE '%' || ${q} || '%' COLLATE NOCASE
            `;

            // 1-3. 출처(Source)
            const sourceRows = await prisma.$queryRaw<IdRow[]>`
              SELECT DISTINCT issueId AS id
              FROM Source
              WHERE (title  LIKE '%' || ${q} || '%' COLLATE NOCASE)
                 OR (outlet LIKE '%' || ${q} || '%' COLLATE NOCASE)
            `;

            const idSet = new Set<string>([
              ...textRows.map(r => r.id),
              ...tagRows.map(r => r.id),
              ...sourceRows.map(r => r.id),
            ]);
            if (idSet.size === 0) return [];

            // 상세 조회 (최신순)
            const issues = await prisma.issue.findMany({
              where: { id: { in: Array.from(idSet) } },
              orderBy: { createdAt: "desc" },
              take: 30,
              select: {
                id: true,
                title: true,
                summary: true,
                tags: true,
                createdAt: true,
                updatedAt: true,
                sources: {
                  take: 2,
                  orderBy: { createdAt: "asc" },
                  select: { outlet: true, side: true },
                },
              },
            });

            return issues as IssueDTO[];
          })()
        : Promise.resolve([]);

    /* =========================
     * 2) 아젠다 검색 (Agenda)
     *   - 제목/내용 LIKE NOCASE (raw)
     *   - 태그 json_each LIKE NOCASE (raw)
     * ========================= */
    const agendasPromise: Promise<AgendaDTO[] | []> =
      scope !== "media"
        ? (async () => {
            // 2-1. 제목/내용
            const textRows = await prisma.$queryRaw<IdRow[]>`
              SELECT a.id
              FROM Agenda a
              WHERE (a.title   LIKE '%' || ${q} || '%' COLLATE NOCASE)
                 OR (a.content LIKE '%' || ${q} || '%' COLLATE NOCASE)
            `;

            // 2-2. 태그
            const tagRows = await prisma.$queryRaw<IdRow[]>`
              SELECT DISTINCT a.id
              FROM Agenda AS a, json_each(a.tags) AS t
              WHERE CAST(t.value AS TEXT) LIKE '%' || ${q} || '%' COLLATE NOCASE
            `;

            const idSet = new Set<string>([
              ...textRows.map(r => r.id),
              ...tagRows.map(r => r.id),
            ]);
            if (idSet.size === 0) return [];

            const agendas = await prisma.agenda.findMany({
              where: { id: { in: Array.from(idSet) } },
              orderBy: { createdAt: "desc" },
              take: 30,
              select: {
                id: true,
                title: true,
                content: true,
                tags: true,
                createdAt: true,
                likesCount: true,
                commentCount: true,
              },
            });

            return agendas as AgendaDTO[];
          })()
        : Promise.resolve([]);

    const [issues, agendas] = await Promise.all([issuesPromise, agendasPromise]);
    return res.json({ issues, agendas });
  } catch (e) {
    console.error("[/api/search] error:", e);
    // UX 보존: 에러 시에도 빈 결과 반환
    return res.json({ issues: [] as IssueDTO[], agendas: [] as AgendaDTO[] });
  }
});

export default searchRouter;
