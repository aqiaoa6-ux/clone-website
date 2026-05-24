import crypto from "crypto";

const JWT_SECRET = process.env.SESSION_SECRET ?? "dev-secret-2024";
export const COOKIE_NAME = "auth_token";
const TOKEN_EXPIRY = 7 * 24 * 3600; // 7 days in seconds

export interface JwtPayload {
  userId: number;
  username: string;
  isAdmin: boolean;
}

export type CardType = "daily" | "weekly" | "monthly";

export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(`${salt}:${derived.toString("hex")}`);
    });
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, stored] = hash.split(":");
    if (!salt || !stored) return resolve(false);
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else {
        try {
          resolve(crypto.timingSafeEqual(Buffer.from(derived.toString("hex")), Buffer.from(stored)));
        } catch {
          resolve(false);
        }
      }
    });
  });
}

export function createToken(payload: JwtPayload): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY,
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const [header, body, sig] = token.split(".");
    if (!header || !body || !sig) return null;
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
    if (Buffer.from(expected).length !== Buffer.from(sig).length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as JwtPayload & { exp: number };
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { userId: payload.userId, username: payload.username, isAdmin: payload.isAdmin };
  } catch {
    return null;
  }
}

export function generateCardKey(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = "";
    for (let i = 0; i < 4; i++) {
      group += chars[crypto.randomInt(chars.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

export function cardTypeDurationMs(type: CardType): number {
  if (type === "daily") return 24 * 60 * 60 * 1000;
  if (type === "weekly") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

export const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: TOKEN_EXPIRY * 1000,
  path: "/",
};

// Must include same Secure/SameSite/HttpOnly flags as COOKIE_OPTS, otherwise
// browsers following RFC 6265bis won't delete a Secure cookie without them.
export const CLEAR_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};
