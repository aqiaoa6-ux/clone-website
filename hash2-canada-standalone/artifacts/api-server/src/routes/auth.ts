import { type Response, Router } from "express";
import { db } from "@workspace/db";
import { users } from "@workspace/db";
import { eq, count, sql } from "drizzle-orm";
import { hashPassword, verifyPassword, createToken, verifyToken, COOKIE_NAME, COOKIE_OPTS, CLEAR_COOKIE_OPTS } from "../lib/auth";
import { requireAuth } from "../middleware/requireAuth";
import { stopUserAutoBet } from "./telegram";

const router = Router();

async function ensureUsersTable() {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "users" (
      "id" serial PRIMARY KEY,
      "username" text NOT NULL,
      "password_hash" text NOT NULL,
      "admin_secret_hash" text,
      "is_admin" boolean NOT NULL DEFAULT false,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "tg_session_string" text
    )
  `));

  await db.execute(sql.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "users_username_unique_idx"
    ON "users" ("username")
  `));

  await db.execute(sql.raw(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "admin_secret_hash" text`));
  await db.execute(sql.raw(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean NOT NULL DEFAULT false`));
  await db.execute(sql.raw(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_at" timestamp NOT NULL DEFAULT now()`));
  await db.execute(sql.raw(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tg_session_string" text`));
}

function normalizeUsername(username: string): string {
  return username.trim();
}

function validateCredentials(username: string | undefined, password: string | undefined): { username: string; password: string } | { error: string } {
  const normalizedUsername = normalizeUsername(username ?? "");
  if (!normalizedUsername || !password) return { error: "请填写用户名和密码" };
  if (normalizedUsername.length < 3 || normalizedUsername.length > 20) return { error: "用户名需 3-20 个字符" };
  if (password.length < 6) return { error: "密码至少 6 个字符" };
  return { username: normalizedUsername, password };
}

function issueAuthCookie(res: Response, user: { id: number; username: string; isAdmin: boolean }) {
  const token = createToken({ userId: user.id, username: user.username, isAdmin: user.isAdmin });
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
}

router.post("/auth/register", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const validated = validateCredentials(username, password);
  if ("error" in validated) {
    res.status(400).json({ error: validated.error }); return;
  }

  try {
    await ensureUsersTable();

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, validated.username)).limit(1);
    if (existing) { res.status(400).json({ error: "用户名已被注册" }); return; }

    const [{ total }] = await db.select({ total: count() }).from(users);
    const isAdmin = Number(total) === 0;

    const passwordHash = await hashPassword(validated.password);
    const [newUser] = await db.insert(users).values({ username: validated.username, passwordHash, isAdmin }).returning();
    if (!newUser) throw new Error("insert failed");

    issueAuthCookie(res, { id: newUser.id, username: newUser.username, isAdmin: newUser.isAdmin });
    res.json({ ok: true, user: { id: newUser.id, username: newUser.username, isAdmin: newUser.isAdmin } });
  } catch (err) {
    req.log.error(err, "register failed");
    res.status(500).json({ error: "注册失败，请检查数据库连接" });
  }
});

router.post("/auth/login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const validated = validateCredentials(username, password);
  if ("error" in validated) {
    res.status(400).json({ error: validated.error }); return;
  }

  try {
    await ensureUsersTable();

    const [user] = await db.select().from(users).where(eq(users.username, validated.username)).limit(1);
    if (!user) { res.status(401).json({ error: "用户名或密码错误" }); return; }
    const ok = await verifyPassword(validated.password, user.passwordHash);
    if (!ok) { res.status(401).json({ error: "用户名或密码错误" }); return; }

    issueAuthCookie(res, { id: user.id, username: user.username, isAdmin: user.isAdmin });
    res.json({ ok: true, user: { id: user.id, username: user.username, isAdmin: user.isAdmin } });
  } catch (err) {
    req.log.error(err, "login failed");
    res.status(500).json({ error: "登录失败，请检查数据库连接" });
  }
});

router.post("/auth/logout", (req, res) => {
  // 登出前停止该用户的自动投注
  const token = (req.cookies as Record<string, string>)?.[COOKIE_NAME];
  if (token) {
    const payload = verifyToken(token);
    if (payload) stopUserAutoBet(payload.userId);
  }
  res.clearCookie(COOKIE_NAME, CLEAR_COOKIE_OPTS);
  res.json({ ok: true });
});

router.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
