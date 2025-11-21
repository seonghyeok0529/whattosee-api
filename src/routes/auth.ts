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
const CLIENT_URL = process.env.CLIENT_URL!; // 예: http://localhost:3000
const EMAIL_AUTH_ENABLED = (process.env.AUTH_EMAIL_ENABLED ?? "false") === "true";

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

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,   // ✅ 로컬은 Lax
    secure: false,              // ✅ http 로컬이므로 false
    path: "/",
    role: true,
    // domain: "localhost",     // 없어도 됨(명시하더라도 localhost면 OK)
    maxAge: REFRESH_DAYS * 24 * 60 * 60 * 1000,
  };
}


/** Google OAuth ===== */
const oauthClient = new OAuth2Client({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: process.env.GOOGLE_REDIRECT_URI!, // 예: http://localhost:8000/api/auth/google/callback
});

router.get("/google", (_req, res) => {
  const url = oauthClient.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    prompt: "consent",
  });
  return res.redirect(url);
});

async function getGoogleUserProfile(code: string): Promise<{ email: string; name?: string }> {
  const { tokens } = await oauthClient.getToken(code);
  if (!tokens.id_token) throw new Error("Missing id_token");
  const ticket = await oauthClient.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID!,
  });
  const p = ticket.getPayload();
  if (!p?.email) throw new Error("No email in Google ID token");
  return { email: p.email, name: p.name ?? p.given_name ?? p.family_name };
}

/** 이메일 회원가입/로그인 (옵션) =====
 *  - 스키마에 passwordHash 컬럼이 없더라도 타입에러가 나지 않게 as any 사용
 *  - EMAIL_AUTH_ENABLED=false면 404를 반환
 */
router.post("/register", async (req, res) => {
  if (!EMAIL_AUTH_ENABLED) return res.status(404).json({ error: "EMAIL_AUTH_DISABLED" });

  const { email, password, username } = (req.body ?? {}) as {
    email?: string; password?: string; username?: string;
  };
  if (!email || !password || !username) {
    return res.status(400).json({ error: "email, password, username required" });
  }

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(409).json({ error: "Email already in use" });

  const passwordHash = await bcrypt.hash(password, 12);
  // 스키마가 passwordHash를 가지지 않으면 실제 마이그레이션 전엔 이 라우트를 켜지 마세요.
  const p: any = prisma;
  const user = await p.user.create({
    data: { email, username, passwordHash },
    select: { id: true, email: true, username: true, createdAt: true },
  });

  return res.status(201).json({ user });
});

router.post("/login", async (req, res) => {
  if (!EMAIL_AUTH_ENABLED) return res.status(404).json({ error: "EMAIL_AUTH_DISABLED" });

  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) return res.status(400).json({ error: "email & password required" });

  const p: any = prisma;
  const user = await p.user.findUnique({ where: { email } }); // as any(비번 필드 타입 우회)
  if (!user?.passwordHash) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.passwordHash as string);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const accessToken = signAccessToken({ id: user.id, email: user.email ?? null });
  const raw = newRefreshRaw();
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400 * 1000) },
  });

  return res.cookie(REFRESH_COOKIE, raw, cookieOptions()).json({
    accessToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      nickname: user.nickname,  
    },
  });
  
});

/** 토큰 재발급/로그아웃/ME ===== */
router.post("/refresh", async (req, res) => {
  noStore(res);
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw) return res.status(401).json({ error: "No refresh token" });

  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  const record = await prisma.refreshToken.findFirst({
    where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    include: { user: true },
  });
  if (!record?.user) return res.status(401).json({ error: "Invalid refresh token" });

  const accessToken = signAccessToken({ id: record.user.id, email: record.user.email ?? null });
  return res.json({
    accessToken,
    user: { id: record.user.id, email: record.user.email, username: record.user.username, nickname: record.user.nickname, },
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
  return res.clearCookie(REFRESH_COOKIE, cookieOptions()).json({ ok: true });
});

router.get("/me", async (req, res) => {
  noStore(res);
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as { sub: string };
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        username: true,
        nickname: true, 
        createdAt: true,
        role: true,
      },
    });
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const allowList = (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    const isAdmin = (user.role === "admin") || (user.email ? allowList.includes(user.email.toLowerCase()) : false);

    return res.json({
      user: {
        ...user,
        isAdmin,           // ✅ 프론트 편의를 위한 boolean
        role: user.role,   // ✅ 원본 role도 함께
      },
    });
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
    }
});

/** Google 콜백 ===== */
router.get("/google/callback", async (req, res) => {
  try {
    const code = req.query.code as string;
    if (!code) return res.redirect(CLIENT_URL);

    const { email, name } = await getGoogleUserProfile(code);

    // 기존 유저 조회 (username/nickname 절대 덮어쓰지 않기)
    const existing = await prisma.user.findUnique({ where: { email } });

    let user;
    if (existing) {
      // ✅ 이미 가입한 유저 → 프로필 이름으로 username/nickname 변경 금지
      user = existing;
    } else {
      // ✅ 신규 유저 → nickname 기본값만 소셜 이름으로 세팅
      user = await prisma.user.create({
        data: {
          email,
          username: email ?? crypto.randomBytes(8).toString("hex"), // 내부 식별용
          nickname: name ?? "사용자",                               // 화면용 닉네임
          googleId: email, // 필요하면 별도 필드에 ID 저장
        },
      });
    }

    const accessToken = signAccessToken({ id: user.id, email: user.email ?? null });

    const raw = newRefreshRaw();
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400 * 1000) },
    });
    res.cookie(REFRESH_COOKIE, raw, cookieOptions());

    const nextParam = (req.query.next as string | undefined) ?? "/";
    const redirectUrl = existing
      ? `${CLIENT_URL}/oauth/callback?token=${encodeURIComponent(accessToken)}&next=${encodeURIComponent(nextParam)}`
      : `${CLIENT_URL}/oauth/callback?token=${encodeURIComponent(accessToken)}&new=1`;

    return res.redirect(redirectUrl);
  } catch (err) {
    console.error("Google OAuth error:", err);
    return res.status(500).json({ error: "OAuth failed" });
  }
});


/** --- 공통 OAuth 유틸 --- */
const OAUTH_STATE_COOKIE = "oauth_state";
const stateCookieOpts = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: false,
  path: "/",
  maxAge: 5 * 60 * 1000,
};

/** Kakao ===== */
router.get("/kakao", (_req, res) => {
  const state = randomBytes(16).toString("hex");
  res.cookie(OAUTH_STATE_COOKIE, state, stateCookieOpts);
  const authUrl =
    "https://kauth.kakao.com/oauth/authorize?" +
    new URLSearchParams({
      client_id: process.env.KAKAO_CLIENT_ID!,
      redirect_uri: process.env.KAKAO_REDIRECT_URI!,
      response_type: "code",
      scope: "account_email profile_nickname",
      state,
    }).toString();
  return res.redirect(authUrl);
});

router.get("/kakao/callback", async (req, res) => {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const stateCookie = req.cookies?.[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE, stateCookieOpts);

    if (!code) return res.redirect(CLIENT_URL);
    if (!state || !stateCookie || state !== stateCookie) {
      return res.status(400).send("Invalid OAuth state");
    }

    // token
    const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
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
    const accessToken = tokenJson.access_token as string;

    // me
    const meRes = await fetch("https://kapi.kakao.com/v2/user/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!meRes.ok) throw new Error(await meRes.text());
    const me = (await meRes.json()) as any;
    const kakaoId = String(me.id);
    const email: string | undefined = me.kakao_account?.email;
    const nickname: string | undefined = me.kakao_account?.profile?.nickname;

    // upsert
    let user;
    if (email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        user = existing; // ✅ 닉네임 덮어쓰기 금지
      } else {
        user = await prisma.user.create({
          data: {
            email,
            kakaoId,
            username: email ?? kakaoId,
            nickname: nickname ?? "사용자",
          },
        });
      }
    } else {
      const existing = await prisma.user.findUnique({ where: { kakaoId } });
      if (existing) {
        user = existing;
      } else {
        user = await prisma.user.create({
          data: {
            kakaoId,
            email: null,
            username: kakaoId,
            nickname: nickname ?? "사용자",
          },
        });
      }
    }

    const accessJwt = signAccessToken({ id: user.id, email: user.email ?? null });
    const raw = newRefreshRaw();
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400 * 1000) },
    });
    res.cookie(REFRESH_COOKIE, raw, cookieOptions());

    const existing = email
      ? await prisma.user.findUnique({ where: { email } })
      : await prisma.user.findUnique({ where: { kakaoId } });

    const redirectUrl = existing
      ? `${CLIENT_URL}/oauth/callback?token=${encodeURIComponent(accessJwt)}`
      : `${CLIENT_URL}/oauth/callback?token=${encodeURIComponent(accessJwt)}&new=1`;

    return res.redirect(redirectUrl);
  } catch (err) {
    console.error("Kakao OAuth error:", err);
    return res.status(500).json({ error: "Kakao OAuth failed" });
  }
});

/** Naver ===== */
router.get("/naver", (_req, res) => {
  const state = randomBytes(16).toString("hex");
  res.cookie(OAUTH_STATE_COOKIE, state, stateCookieOpts);
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
    const code = req.query.code as string;
    const state = req.query.state as string;
    const stateCookie = req.cookies?.[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE, stateCookieOpts);

    if (!code) return res.redirect(CLIENT_URL);
    if (!state || !stateCookie || state !== stateCookie) {
      return res.status(400).send("Invalid OAuth state");
    }

    // token
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

    // me
    const meRes = await fetch("https://openapi.naver.com/v1/nid/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!meRes.ok) throw new Error(await meRes.text());
    const me = (await meRes.json()) as { response?: any };
    const profile = me?.response ?? {};
    const naverId = String(profile.id);
    const email: string | undefined = profile.email;
    const nickname: string | undefined = profile.nickname;

    // upsert
    let user;
if (email) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    user = existing;
  } else {
    user = await prisma.user.create({
      data: {
        email,
        naverId,
        username: email ?? naverId,
        nickname: nickname ?? "사용자",
      },
    });
  }
} else {
  const existing = await prisma.user.findUnique({ where: { naverId } });
  if (existing) {
    user = existing;
  } else {
    user = await prisma.user.create({
      data: {
        naverId,
        email: null,
        username: naverId,
        nickname: nickname ?? "사용자",
      },
    });
  }
}


    const accessJwt = signAccessToken({ id: user.id, email: user.email ?? null });
    const raw = newRefreshRaw();
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400 * 1000) },
    });
    res.cookie(REFRESH_COOKIE, raw, cookieOptions());

    const existing = email
      ? await prisma.user.findUnique({ where: { email } })
      : await prisma.user.findUnique({ where: { naverId } });

    const redirectUrl = existing
      ? `${CLIENT_URL}/oauth/callback?token=${encodeURIComponent(accessJwt)}`
      : `${CLIENT_URL}/oauth/callback?token=${encodeURIComponent(accessJwt)}&new=1`;

    return res.redirect(redirectUrl);
  } catch (err) {
    console.error("Naver OAuth error:", err);
    return res.status(500).json({ error: "Naver OAuth failed" });
  }
});

/** 계정 삭제 ===== */
router.delete("/delete", async (req, res) => {
  noStore(res);
  try {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as { sub: string };
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

    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    return res.json({ ok: true, message: "Account deleted and logged out" });
  } catch (err) {
    console.error("Account deletion failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
