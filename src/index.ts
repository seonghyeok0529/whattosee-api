import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import { PrismaClient } from "@prisma/client"; // ✅ Prisma 추가

dotenv.config();

import commentsRouter from "./routes/comments.js";
import authRouter from "./routes/auth.js";
import authMe from "./routes/auth.me.js";
import profileRouter from "./routes/profile.js";
import agendasRouter from "./routes/agendas.js";
import ctiRouter from "./routes/cti.js";
import likesRouter from "./routes/likes.js";
import searchRouter from "./routes/search.js";
import { adminIngestRouter } from "./routes/adminIngest.js";
import { issuesRouter } from "./routes/issues.js";
import votesRouter from "./routes/votes.js";
import issueCommentsRouter from "./routes/issueComments.js";
import adminCluster from "./routes/adminCluster.js";
import adminMetricsRouter from "./routes/adminMetrics.js";
import trackRouter from "./routes/track.js";
import { adminIssueRoutes } from "./routes/adminIssue.js";
import adminAgendaRouter from "./routes/adminAgenda.js";
import { newsClipsRouter } from "./routes/newsClips.js";
import clipIssueCommentsRouter from "./routes/clipIssueComments.js";
import adminNewsClipsRouter from "./routes/adminNewsClips.js";
import communityRoutes from "./routes/community.js";
import adminCommunityRouter from "./routes/adminCommunity.js";

// ✅ 단일 세션 미들웨어만 사용
import { ensureSession } from "./middleware/ensureSession";

const app = express();
const prisma = new PrismaClient(); // ✅ Prisma 인스턴스
app.set("trust proxy", 1);

//app.set("etag",false);

/** CORS */
const allowedOrigins = [
  process.env.CORS_ORIGIN ?? "http://localhost:3000",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "https://whattosee.now",
  // ✅ Azure Web App 도메인 추가
  "https://whattosee-api-f9f3h2fze0gncffe.koreacentral-01.azurewebsites.net",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // 앱/클라이언트/서버간 내부 호출 허용
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

/** Common */
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

/** Health */
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

/** ✅ DB 연결 확인용 라우트 (배포/디버깅용) */
app.get("/debug/db", async (_req, res) => {
  try {
    const userCount = await prisma.user.count();
    res.json({ ok: true, userCount });
  } catch (err) {
    console.error("[DEBUG/DB ERROR]", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/** ✅ 세션을 모든 /api 라우터 **앞**에 */
app.use("/api", ensureSession);

/** Routers */
app.use("/api/auth", authRouter);
app.use("/api/auth", authMe);
//app.use("/api/admin", adminRouter);
app.use("/api/comments", commentsRouter);
app.use("/api/profile", profileRouter);
app.use("/api/agendas", agendasRouter);
app.use("/api/cti", ctiRouter);
app.use("/api/likes", likesRouter);
app.use("/api/search", searchRouter);
app.use("/api/admin", adminIngestRouter);
app.use("/api/issues", issuesRouter);
app.use("/api/votes", votesRouter);
app.use("/api/issues", issueCommentsRouter);
app.use("/api/admin/cluster", adminCluster);
app.use("/api", adminMetricsRouter);
app.use("/api/admin", adminIssueRoutes); // 여기는 이슈, 사용자, 유저, 사람, 신고
app.use("/api/admin", adminAgendaRouter); // 여기는 Agenda만
app.use("/api/news-clips", newsClipsRouter);
app.use("/api", clipIssueCommentsRouter);
app.use("/api/admin", adminNewsClipsRouter);
app.use("/api/admin", adminCommunityRouter);
app.use("/api", communityRoutes);

/** ✅ 트래킹 (세션 뒤) */
app.use("/api", trackRouter);

/** 404 */
app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));

/** Server */
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`✅ API server running on http://localhost:${PORT}`);
});
