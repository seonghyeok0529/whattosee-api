// src/utils/jwt.ts
import jwt from 'jsonwebtoken';

const ACCESS_EXPIRES = '1h';

export function signAccess(payload: object) {
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET!, { expiresIn: ACCESS_EXPIRES });
}
