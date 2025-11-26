// src/routes/events.ts
import { Router } from "express";
import { prisma } from "../lib/prisma";
import type { Request, Response } from "express";

export const eventsRouter = Router();

interface AnalyticsEventBody {
  type: string;
  issueId?: string;
  issueTitle?: string;
  section?: string;
  ts?: string;
  sid: string;
  path?: string;
  ua?: string;
}

eventsRouter.post("/", async (req: Request, res: Response) => {
  const body = req.body as AnalyticsEventBody | undefined;
  if (!body || !body.type || !body.sid) {
    return res.status(400).json({ ok: false });
  }

  const userId = (req as any).userId as string | undefined;

  let ctiTypeSnapshot: string | null = null;
  let region1: string | null = null;
  let region2: string | null = null;

  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        ctiType: true,
        regionLevel1: true,
        regionLevel2: true,
      },
    });

    if (user) {
      ctiTypeSnapshot = user.ctiType;
      region1 = user.regionLevel1;
      region2 = user.regionLevel2;
    }
  }

  await prisma.eventLog.create({
    data: {
      eventType: body.type,
      sessionId: body.sid,
      userId,

      pagePath: body.path,
      section: body.section,
      issueId: body.issueId,
      issueTitle: body.issueTitle,

      ctiTypeSnapshot,
      regionLevel1Snapshot: region1,
      regionLevel2Snapshot: region2,

      userAgent: body.ua ?? (req.headers["user-agent"] as string | undefined),
      payload: body as any,
    },
  });

  return res.json({ ok: true });
});
