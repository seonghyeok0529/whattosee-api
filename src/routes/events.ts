// src/routes/events.ts
import { Router } from "express";
import { prisma } from "../lib/prisma";
import type { Request, Response } from "express";

export const eventsRouter = Router();

/**
 * 공통 이벤트 바디 타입
 * - 기존 웹에서 쓰던 필드 + 모바일/GA4용 필드(params, platform)까지 포함
 */
interface AnalyticsEventBody {
  // 필수
  type: string; // GA4 event_name에 해당
  sid: string;  // 세션 ID

  // 선택 필드 (페이지/이슈/섹션)
  issueId?: string;
  issueTitle?: string;
  section?: string;
  path?: string; // pagePath (웹: location.pathname, 앱: expo-router 경로)

  // 클라이언트 타임스탬프 (ms 또는 ISO 문자열 예상)
  ts?: string;

  // userAgent override
  ua?: string;

  // GA4-style metadata
  platform?: "web" | "android" | "ios" | string; // 자유롭게 문자열 허용
  params?: Record<string, any>; // GA4 event params
}

eventsRouter.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body as AnalyticsEventBody | undefined;

    if (!body || !body.type || !body.sid) {
      return res.status(400).json({ ok: false, error: "type, sid는 필수입니다." });
    }

    const userId = (req as any).userId as string | undefined;

    // 🔹 유저 스냅샷 (ctiType, 지역)
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

    // 🔹 클라이언트에서 보낸 ts가 있으면 createdAt에 반영 (없으면 DB default now())
    let createdAt: Date | undefined = undefined;
    if (body.ts) {
      // ms 숫자 or ISO 문자열 둘 다 허용
      const asNumber = Number(body.ts);
      if (!Number.isNaN(asNumber)) {
        createdAt = new Date(asNumber);
      } else {
        const asDate = new Date(body.ts);
        if (!Number.isNaN(asDate.getTime())) {
          createdAt = asDate;
        }
      }
    }

    // 🔹 payload: 기본적으로 GA4-style params를 우선 저장,
    //            없으면 body 전체를 저장 (기존 웹 이벤트와 호환)
    const payload: any = body.params ?? (body as any);

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

        payload,
        // ts가 유효하면 createdAt을 override, 아니면 생략 → DB default(now())
        ...(createdAt ? { createdAt } : {}),
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[eventsRouter] /api/events error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});
