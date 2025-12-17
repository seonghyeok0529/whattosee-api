// src/routes/auth.ts
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { PrismaClient, type Prisma } from "@prisma/client";
import crypto, { randomBytes } from "crypto";
import { OAuth2Client } from "google-auth-library";

const router = Router();
const prisma = new PrismaClient();

const noStore = (res: any) => res.set("Cache-Control", "no-store");

const REFRESH_COOKIE = "rt";
const REFRESH_DAYS = parseInt(process.env.REFRESH_TOKEN_DAYS ?? "30", 10);
const CLIENT_URL = process.env.CLIENT_URL!; // 예: https://whattosee.now
const EMAIL_AUTH_ENABLED =
  (process.env.AUTH_EMAIL_ENABLED ?? "false") === "true";

/* ─────────────────────────────────────────────
   ✅ HTTPS 판별 (프록시/로드밸런서 환경 대응)
   - 배포 환경에서 NODE_ENV가 production이 아니어도 안전하게 동작
───────────────────────────────────────────── */
function isHttpsReq(req?: any) {
  const forced = process.env.FORCE_HTTPS === "true";
  const xfProto = (req?.headers?.["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  return (
    forced ||
    req?.secure === true ||
    xfProto === "https" ||
    process.env.NODE_ENV === "production"
  );
}

/** JWT ===== */
function signAccessToken(user: { id: string; email: string | null }) {
  return jwt.sign(
    { sub: user.id, email: user.email ?? null },
    process.env.JWT_ACCESS_SECRET!,
    { expiresIn: "15m" }
  );
}

function newRefreshRaw() {
  return crypto.randomBytes(64).toString("hex");
}

/* ─────────────────────────────────────────────
   ✅ Refresh Cookie 옵션
   - cross-site(whattosee.now -> api.whattosee.now)에서 쿠키가 붙으려면:
     SameSite=None + Secure(HTTPS) 가 사실상 필수
───────────────────────────────────────────── */
function refreshCookieOptions(req?: any) {
  const https = isHttpsReq(req);

  return {
    httpOnly: true,
    sameSite: (https ? ("none" as const) : ("lax" as const)),
    secure: https,
    path: "/",
    maxAge: REFRESH_DAYS * 24 * 60 * 60 * 1000,
  };
}

/* ──────────────────────────────
   공통: OAuth 상태/앱 리다이렉트 쿠키
   - 이 쿠키들은 "api.whattosee.now" 안에서만 왕복(google -> callback)하므로
     SameSite=Lax로 충분하고, HTTPS면 Secure로 맞추기
────────────────────────────── */
const OAUTH_STATE_COOKIE = "oauth_state";
const APP_REDIRECT_COOKIE = "app_redirect";

function transientCookieOptions(req?: any) {
  const https = isHttpsReq(req);
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: https,
    path: "/",
    maxAge: 5 * 60 * 1000,
  };
}

/* ──────────────────────────────
   Google OAuth
────────────────────────────── */

// ✅ 반드시 /api/auth/google/callback 이어야 함 (Express에선 /api/auth 로 mount)
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ??
  "https://api.whattosee.now/api/auth/google/callback";

console.log("[AUTH] GOOGLE_REDIRECT_URI =", GOOGLE_REDIRECT_URI);

const oauthClient = new OAuth2Client({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: GOOGLE_REDIRECT_URI,
});

// 🔹 앱/웹 공통 진입점
router.get("/google", (req, res) => {
  const { platform, redirect_uri } = req.query as {
    platform?: string;
    redirect_uri?: string;
  };

  console.log("[AUTH /google] platform:", platform, "redirect_uri:", redirect_uri);

  // 앱에서 온 요청이면, 앱 딥링크 redirect_uri를 쿠키에 저장
  if (platform === "app" && redirect_uri) {
    console.log("[AUTH /google] set APP_REDIRECT_COOKIE:", redirect_uri);
    res.cookie(APP_REDIRECT_COOKIE, redirect_uri, transientCookieOptions(req));
  }

  // CSRF 방지 & 디버깅용 state
  const statePayload = JSON.stringify({
    platform: platform ?? "web",
    redirect_uri: redirect_uri ?? null,
  });

  const url = oauthClient.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    prompt: "consent",
    state: statePayload,
  });

  console.log("[AUTH /google] generated Google auth URL:", url);
  return res.redirect(url);
});

async function getGoogleUserProfile(
  code: string
): Promise<{ email: string; name?: string }> {
  console.log("[AUTH getGoogleUserProfile] code:", code);
  const { tokens } = await oauthClient.getToken(code);
  console.log(
    "[AUTH getGoogleUserProfile] tokens received, has id_token:",
    !!tokens.id_token
  );

  if (!tokens.id_token) throw new Error("Missing id_token");
  const ticket = await oauthClient.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID!,
  });
  const p = ticket.getPayload();

  if (!p?.email) throw new Error("No email in Google ID token");
  return { email: p.email, name: p.name ?? p.given_name ?? p.family_name };
}

/* 이메일 회원가입/로그인 (옵션) ==================== */
router.post("/register", async (req, res) => {
  if (!EMAIL_AUTH_ENABLED)
    return res.status(404).json({ error: "EMAIL_AUTH_DISABLED" });

  const { email, password, username } = (req.body ?? {}) as {
    email?: string;
    password?: string;
    username?: string;
  };
  if (!email || !password || !username) {
    return res
      .status(400)
      .json({ error: "email, password, username required" });
  }

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(409).json({ error: "Email already in use" });

  const passwordHash = await bcrypt.hash(password, 12);
  const p: any = prisma;
  const user = await p.user.create({
    data: { email, username, passwordHash },
    select: { id: true, email: true, username: true, createdAt: true },
  });

  return res.status(201).json({ user });
});

router.post("/login", async (req, res) => {
  if (!EMAIL_AUTH_ENABLED)
    return res.status(404).json({ error: "EMAIL_AUTH_DISABLED" });

  const { email, password } = (req.body ?? {}) as {
    email?: string;
    password?: string;
  };
  if (!email || !password)
    return res.status(400).json({ error: "email & password required" });

  const p: any = prisma;
  const user = await p.user.findUnique({ where: { email } });
  if (!user?.passwordHash)
    return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.passwordHash as string);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const accessToken = signAccessToken({
    id: user.id,
    email: user.email ?? null,
  });

  const raw = newRefreshRaw();
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400 * 1000),
    },
  });

  return res.cookie(REFRESH_COOKIE, raw, refreshCookieOptions(req)).json({
    accessToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      nickname: user.nickname,
    },
  });
});

/* 토큰 재발급/로그아웃/ME ==================== */
router.post("/refresh", async (req, res) => {
  noStore(res);

  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw) return res.status(401).json({ error: "No refresh token" });

  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  const record = await prisma.refreshToken.findFirst({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    include: { user: true },
  });

  if (!record?.user)
    return res.status(401).json({ error: "Invalid refresh token" });

  const accessToken = signAccessToken({
    id: record.user.id,
    email: record.user.email ?? null,
  });

  // ✅ 슬라이딩(체감 로그아웃 방지) - 쿠키를 다시 set
  res.cookie(REFRESH_COOKIE, raw, refreshCookieOptions(req));

  return res.json({
    accessToken,
    user: {
      id: record.user.id,
      email: record.user.email,
      username: record.user.username,
      nickname: record.user.nickname,
    },
  });
});

router.post("/logout", async (req, res) => {
  noStore(res);

  const raw = req.cookies?.[REFRESH_COOKIE];
  if (raw) {
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ✅ clearCookie 옵션이 setCookie와 정확히 같아야 실제로 지워짐
  return res
    .clearCookie(REFRESH_COOKIE, refreshCookieOptions(req))
    .json({ ok: true });
});

router.get("/me", async (req, res) => {
  noStore(res);
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_ACCESS_SECRET!
    ) as { sub: string };

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        username: true,
        nickname: true,
        createdAt: true,
        role: true,
        tosAgreedAt: true,
        privacyAgreedAt: true,
        marketingAgreed: true,
        ctiType: true,
        ctiScores: true,
      },
    });
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const allowList = (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const isAdmin =
      user.role === "admin" ||
      (user.email ? allowList.includes(user.email.toLowerCase()) : false);

    return res.json({
      user: {
        ...user,
        isAdmin,
        role: user.role,
        marketingOptIn: user.marketingAgreed ?? false,
      },
    });
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
});

/* Google 콜백 ==================== */
router.get("/google/callback", async (req, res) => {
  try {
    console.log("[AUTH /google/callback] query:", req.query);

    const code = req.query.code as string;
    if (!code) return res.redirect(CLIENT_URL);

    const appRedirect = req.cookies?.[APP_REDIRECT_COOKIE] as string | undefined;
    if (appRedirect) {
      res.clearCookie(APP_REDIRECT_COOKIE, transientCookieOptions(req));
    }

    const { email, name } = await getGoogleUserProfile(code);

    const existing = await prisma.user.findUnique({ where: { email } });

    let user;
    if (existing) {
      user = existing;
    } else {
      user = await prisma.user.create({
        data: {
          email,
          username: email ?? crypto.randomBytes(8).toString("hex"),
          nickname: name ?? "사용자",
          googleId: email,
        },
      });
    }

    const accessToken = signAccessToken({
      id: user.id,
      email: user.email ?? null,
    });

    const raw = newRefreshRaw();
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400 * 1000),
      },
    });

    // ✅ refresh 쿠키는 cross-site 고려해서 확실하게 세팅
    res.cookie(REFRESH_COOKIE, raw, refreshCookieOptions(req));

    const nextParam = (req.query.next as string | undefined) ?? "/";

    // 앱이면 앱 딥링크로
    if (appRedirect) {
      const base = appRedirect;
      const sep = base.includes("?") ? "&" : "?";
      const redirectUrl = existing
        ? `${base}${sep}token=${encodeURIComponent(accessToken)}&next=${encodeURIComponent(nextParam)}`
        : `${base}${sep}token=${encodeURIComponent(accessToken)}&new=1`;

      return res.redirect(redirectUrl);
    }

    // 웹이면 CLIENT_URL로
    const redirectUrl = existing
      ? `${CLIENT_URL}/oauth/callback?token=${encodeURIComponent(accessToken)}&next=${encodeURIComponent(nextParam)}`
      : `${CLIENT_URL}/oauth/callback?token=${encodeURIComponent(accessToken)}&new=1`;

    return res.redirect(redirectUrl);
  } catch (err) {
    console.error("Google OAuth error:", err);
    return res.status(500).json({ error: "OAuth failed" });
  }
});

/* Kakao ==================== */
router.get("/kakao", (req, res) => {
  const { platform, redirect_uri } = req.query as {
    platform?: string;
    redirect_uri?: string;
  };

  const state = randomBytes(16).toString("hex");
  res.cookie(OAUTH_STATE_COOKIE, state, transientCookieOptions(req));

  if (platform === "app" && redirect_uri) {
    res.cookie(APP_REDIRECT_COOKIE, redirect_uri, transientCookieOptions(req));
  }

  const redirectUri = process.env.KAKAO_REDIRECT_URI!;
  const authUrl =
    "https://kauth.kakao.com/oauth/authorize?" +
    new URLSearchParams({
      client_id: process.env.KAKAO_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
    }).toString();

  return res.redirect(authUrl);
});

router.get("/kakao/callback", async (req, res) => {
  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const stateCookie = req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined;

    const appRedirect = req.cookies?.[APP_REDIRECT_COOKIE] as string | undefined;
    const isAppFlow = !!appRedirect;

    res.clearCookie(OAUTH_STATE_COOKIE, transientCookieOptions(req));
    if (appRedirect) res.clearCookie(APP_REDIRECT_COOKIE, transientCookieOptions(req));

    if (!code) return res.redirect(CLIENT_URL);

    if (!state || !stateCookie || state !== stateCookie) {
      if (!isAppFlow) return res.status(400).send("Invalid OAuth state");
    }

    const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.KAKAO_CLIENT_ID!,
        client_secret: process.env.KAKAO_CLIENT_SECRET || "",
        redirect_uri: process.env.KAKAO_REDIRECT_URI!,
        code,
      }),
    });

    if (!tokenRes.ok) throw new Error(await tokenRes.text());
    const tokenJson: any = await tokenRes.json();
    const kakaoAccessToken = tokenJson.access_token as string;

    const meRes = await fetch("https://kapi.kakao.com/v2/user/me", {
      headers: { Authorization: `Bearer ${kakaoAccessToken}` },
    });
    if (!meRes.ok) throw new Error(await meRes.text());

    const me = (await meRes.json()) as any;
    const kakaoId = String(me.id);
    const email: string | undefined = me.kakao_account?.email;
    const nickname: string | undefined = me.kakao_account?.profile?.nickname;

    let user;
    if (email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      user =
        existing ??
        (await prisma.user.create({
          data: {
            email,
            kakaoId,
            username: email ?? kakaoId,
            nickname: nickname ?? "사용자",
          },
        }));
    } else {
      const existing = await prisma.user.findUnique({ where: { kakaoId } });
      user =
        existing ??
        (await prisma.user.create({
          data: {
            kakaoId,
            email: null,
            username: kakaoId,
            nickname: nickname ?? "사용자",
          },
        }));
    }

    const accessJwt = signAccessToken({
      id: user.id,
      email: user.email ?? null,
    });

    const raw = newRefreshRaw();
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400 * 1000),
      },
    });
    res.cookie(REFRESH_COOKIE, raw, refreshCookieOptions(req));

    if (appRedirect) {
      const base = appRedirect;
      const sep = base.includes("?") ? "&" : "?";
      return res.redirect(`${base}${sep}token=${encodeURIComponent(accessJwt)}`);
    }

    return res.redirect(`${CLIENT_URL}/oauth/callback?token=${encodeURIComponent(accessJwt)}`);
  } catch (err) {
    console.error("Kakao OAuth error:", err);
    return res.status(500).json({ error: "Kakao OAuth failed" });
  }
});

/* Naver ==================== */
router.get("/naver", (req, res) => {
  const { platform, redirect_uri } = req.query as {
    platform?: string;
    redirect_uri?: string;
  };

  const state = randomBytes(16).toString("hex");
  res.cookie(OAUTH_STATE_COOKIE, state, transientCookieOptions(req));

  if (platform === "app" && redirect_uri) {
    res.cookie(APP_REDIRECT_COOKIE, redirect_uri, transientCookieOptions(req));
  }

  const authUrl =
    "https://nid.naver.com/oauth2.0/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: process.env.NAVER_CLIENT_ID!,
      redirect_uri: process.env.NAVER_REDIRECT_URI!,
      state,
    }).toString();

  return res.redirect(authUrl);
});

router.get("/naver/callback", async (req, res) => {
  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const stateCookie = req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined;

    const appRedirect = req.cookies?.[APP_REDIRECT_COOKIE] as string | undefined;

    res.clearCookie(OAUTH_STATE_COOKIE, transientCookieOptions(req));
    if (appRedirect) res.clearCookie(APP_REDIRECT_COOKIE, transientCookieOptions(req));

    if (!code) return res.redirect(CLIENT_URL);
    if (!state || !stateCookie || state !== stateCookie) {
      return res.status(400).send("Invalid OAuth state");
    }

    const tokenRes = await fetch(
      "https://nid.naver.com/oauth2.0/token?" +
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: process.env.NAVER_CLIENT_ID!,
          client_secret: process.env.NAVER_CLIENT_SECRET!,
          code,
          state,
        }),
      { method: "GET" }
    );
    if (!tokenRes.ok) throw new Error(await tokenRes.text());

    const tokenJson: any = await tokenRes.json();
    const accessToken = tokenJson.access_token as string;

    const meRes = await fetch("https://openapi.naver.com/v1/nid/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!meRes.ok) throw new Error(await meRes.text());

    const me = (await meRes.json()) as { response?: any };
    const profile = me?.response ?? {};
    const naverId = String(profile.id);
    const email: string | undefined = profile.email;
    const nickname: string | undefined = profile.nickname;

    let user;
    if (email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      user =
        existing ??
        (await prisma.user.create({
          data: {
            email,
            naverId,
            username: email ?? naverId,
            nickname: nickname ?? "사용자",
          },
        }));
    } else {
      const existing = await prisma.user.findUnique({ where: { naverId } });
      user =
        existing ??
        (await prisma.user.create({
          data: {
            naverId,
            email: null,
            username: naverId,
            nickname: nickname ?? "사용자",
          },
        }));
    }

    const accessJwt = signAccessToken({
      id: user.id,
      email: user.email ?? null,
    });

    const raw = newRefreshRaw();
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400 * 1000),
      },
    });
    res.cookie(REFRESH_COOKIE, raw, refreshCookieOptions(req));

    if (appRedirect) {
      const base = appRedirect;
      const sep = base.includes("?") ? "&" : "?";
      return res.redirect(`${base}${sep}token=${encodeURIComponent(accessJwt)}`);
    }

    return res.redirect(`${CLIENT_URL}/oauth/callback?token=${encodeURIComponent(accessJwt)}`);
  } catch (err) {
    console.error("Naver OAuth error:", err);
    return res.status(500).json({ error: "Naver OAuth failed" });
  }
});

/* 계정 삭제 ==================== */
router.delete("/delete", async (req, res) => {
  noStore(res);
  try {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const payload = jwt.verify(
      token,
      process.env.JWT_ACCESS_SECRET!
    ) as { sub: string };
    if (!payload?.sub) return res.status(401).json({ error: "Invalid token" });

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(404).json({ error: "User not found" });

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.refreshToken.deleteMany({ where: { userId: user.id } });
      await tx.user.update({
        where: { id: user.id },
        data: {
          email: `deleted:${user.id}`,
          username: "탈퇴한 사용자",
          nickname: "탈퇴한 사용자",
          kakaoId: null,
          naverId: null,
          googleId: null,
        },
      });
    });

    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(req));
    return res.json({ ok: true, message: "Account deleted and logged out" });
  } catch (err) {
    console.error("Account deletion failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
