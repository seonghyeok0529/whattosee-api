import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import prisma from '../lib/prisma.js';
import { signAccess } from '../utils/jwt.js';
import crypto from "crypto";
import { isAdminEmail } from "../utils/admin.js";

const REFRESH_COOKIE = "rt";
const REFRESH_DAYS = parseInt(process.env.REFRESH_TOKEN_DAYS ?? "30", 10);

const router = Router();

const client = new OAuth2Client({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: process.env.OAUTH_CALLBACK_URL!, // http://localhost:8000/api/auth/google/callback
});

function cookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: isProd ? ("none" as const) : ("lax" as const),
    secure: isProd,
    path: "/",
    maxAge: REFRESH_DAYS * 24 * 60 * 60 * 1000,
  };
}

router.get('/google', (_req, res) => {
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid','email','profile'],
    prompt: 'consent',
  });
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  try {
    const code = req.query.code as string | undefined;
    if (!code) return res.status(400).send('Missing code');

    const { tokens } = await client.getToken(code);
    const idToken = tokens.id_token;
    if (!idToken) return res.status(400).send('Missing id_token');

    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID!,
    });
    const payload = ticket.getPayload();
    if (!payload) return res.status(400).send('Invalid payload');

    const googleId = payload.sub!;
    const email = payload.email ?? null;
    const displayName = payload.name || (email ? email.split('@')[0] : 'user');

    // ✅ 관리자 판단
    const admin = isAdminEmail(email);
    const role = admin ? "admin" : "user";

    // ✅ upsert 시 role/isAdmin 세팅
    const user = await prisma.user.upsert({
      where: { googleId },
      update: { email, username: displayName, role: role as any, isAdmin: admin },
      create: { googleId, email, username: displayName, role: role as any, isAdmin: admin },
      select: { id: true, email: true, username: true, role: true, isAdmin: true },
    });

    const accessToken = signAccess({ uid: user.id, email: user.email ?? undefined });

    // refresh 저장
    const raw = crypto.randomBytes(64).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400 * 1000),
      },
    });
    res.cookie(REFRESH_COOKIE, raw, cookieOptions());

    const frontend = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const redirect = `${frontend}/oauth/callback?token=${encodeURIComponent(accessToken)}`;

    return res.redirect(redirect);
  } catch (e) {
    console.error('Google OAuth error:', e);
    return res.status(500).send('OAuth failed');
  }
});

export default router;
