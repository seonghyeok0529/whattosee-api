// src/index.ts
import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import { PrismaClient } from "@prisma/client"; 

dotenv.config();

import commentsRouter from "./routes/comments.js";
import authRouter from "./routes/auth.js";
import authMe from "./routes/auth.me.js";
import profileRouter from "./routes/profile.js";
import agendasRouter from "./routes/agendas.js";
import ctiRouter from "./routes/cti.js";
import irtRouter from "./routes/irt.js"; // ✅ IRT 추가
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
import { adminIssueYoutubeRoutes } from "./routes/adminIssueYoutube.js";

import { ensureSession } from "./middleware/ensureSession";

const app = express();
const prisma = new PrismaClient();

app.set("trust proxy", 1);

/* ======================================================
 * CORS
 * ====================================================== */

const allowedOrigins = new Set([
  process.env.CORS_ORIGIN ?? "http://localhost:3000",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "https://whattosee.now",
  "https://www.whattosee.now",
  "https://whattosee-api-f9f3h2fze0gncffe.koreacentral-01.azurewebsites.net",
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);

      console.warn("[CORS BLOCKED] origin:", origin);
      return cb(new Error(`CORS blocked: ${origin}`), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

/* ======================================================
 * Common Middleware
 * ====================================================== */

app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

/* ======================================================
 * Health & Debug
 * ====================================================== */

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/debug/db", async (_req, res) => {
  try {
    const userCount = await prisma.user.count();
    res.json({ ok: true, userCount });
  } catch (err) {
    console.error("[DEBUG/DB ERROR]", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ======================================================
 * 세션 강제 (auth 제외)
 * ====================================================== */

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth")) return next();
  return ensureSession(req, res, next);
});

/* ======================================================
 * Routers
 * ====================================================== */

app.use("/api/auth", authRouter);
app.use("/api/auth", authMe);

app.use("/api/comments", commentsRouter);
app.use("/api/profile", profileRouter);

app.use("/api/cti", ctiRouter);
app.use("/api/irt", irtRouter); // ✅ IRT 연결

app.use("/api/agendas", agendasRouter);
app.use("/api/likes", likesRouter);
app.use("/api/search", searchRouter);

app.use("/api/admin", adminIngestRouter);
app.use("/api/issues", issuesRouter);
app.use("/api/votes", votesRouter);
app.use("/api/issues", issueCommentsRouter);

app.use("/api/admin/cluster", adminCluster);
app.use("/api", adminMetricsRouter);
app.use("/api/admin", adminIssueRoutes);
app.use("/api/admin", adminAgendaRouter);
app.use("/api/news-clips", newsClipsRouter);
app.use("/api", clipIssueCommentsRouter);
app.use("/api/admin", adminNewsClipsRouter);
app.use("/api/admin", adminCommunityRouter);
app.use("/api/admin", adminIssueYoutubeRoutes);
app.use("/api", communityRoutes);

/* ======================================================
 * Tracking
 * ====================================================== */

app.use("/api", trackRouter);

/* ======================================================
 * 404
 * ====================================================== */

app.use((_req, res) => {
  res.status(404).json({ error: "NOT_FOUND" });
});

/* ======================================================
 * Server Start
 * ====================================================== */

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
  console.log(`✅ API server running on http://localhost:${PORT}`);
});
