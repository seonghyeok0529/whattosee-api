import { Router } from "express";
import { requireAuth } from "@/middleware/requireAuth.js";
import { adminAuth } from "@/middleware/adminAuth.js";
import {
  getIssueYoutubeAnalyticsCache,
  getOrCreateIssueYoutubeAnalytics,
  parseForceQuery,
} from "@/services/issueYoutubeAnalytics.js";

export const adminIssueYoutubeRoutes = Router();

adminIssueYoutubeRoutes.get(
  "/issues/:issueId/youtube/analyze",
  requireAuth,
  adminAuth,
  async (req, res) => {
    try {
      const issueId = String(req.params.issueId ?? "").trim();
      if (!issueId) {
        return res.status(400).json({ ok: false, error: "INVALID_ISSUE_ID" });
      }

      const cached = await getIssueYoutubeAnalyticsCache(issueId);
      if (!cached) {
        return res.status(404).json({ ok: false, error: "YOUTUBE_ANALYTICS_CACHE_NOT_FOUND" });
      }

      return res.json(cached);
    } catch (err) {
      console.error("[admin issue youtube] cache get failed", err);
      return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
    }
  }
);

adminIssueYoutubeRoutes.post(
  "/issues/:issueId/youtube/analyze",
  requireAuth,
  adminAuth,
  async (req, res) => {
    try {
      const issueId = String(req.params.issueId ?? "").trim();
      if (!issueId) {
        return res.status(400).json({ ok: false, error: "INVALID_ISSUE_ID" });
      }

      const force = parseForceQuery(req.query.force);
      const payload = await getOrCreateIssueYoutubeAnalytics(issueId, { force });
      return res.json(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message === "ISSUE_NOT_FOUND") {
        return res.status(404).json({ ok: false, error: "ISSUE_NOT_FOUND" });
      }

      if (message === "YOUTUBE_API_KEY_MISSING") {
        return res.status(503).json({
          ok: false,
          error: "YOUTUBE_API_KEY_MISSING",
          message: "YOUTUBE_API_KEY 환경변수가 없어 유튜브 분석을 실행할 수 없습니다.",
        });
      }

      console.error("[admin issue youtube] analyze failed", err);
      return res.status(500).json({
        ok: false,
        error: "YOUTUBE_ANALYTICS_FAILED",
        message: "유튜브 분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
      });
    }
  }
);
