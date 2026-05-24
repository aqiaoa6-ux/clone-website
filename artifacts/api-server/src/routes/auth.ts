import { Router } from "express";
import { db } from "@workspace/db";
import { users } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { hashPassword, verifyPassword, createToken, COOKIE_NAME, COOKIE_OPTS, CLEAR_COOKIE_OPTS } from "../lib/auth";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

router.post("/auth/register", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username?.trim() || !password) {
    res.status(400).json({ error: "请填写用户名和密码" }); return;
  }
  const u = username.trim();
  if (u.length < 3 || u.length > 20) {
    res.status(400).json({ error: "用户名需 3-20 个字符" }); return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "密码至少 6 个字符" }); return;
  }
  try {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, u)).limit(1);
    if (existing) { res.status(400).json({ error: "用户名已被注册" }); return; }

    const [{ total }] = await db.select({ total: count() }).from(users);
    const isAdmin = Number(total) === 0;

    const passwordHash = await hashPassword(password);
    const [newUser] = await db.insert(users).values({ username: u, passwordHash, isAdmin }).returning();
    if (!newUser) throw new Error("insert failed");

    const token = createToken({ userId: newUser.id, username: newUser.username, isAdmin: newUser.isAdmin });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ ok: true, user: { id: newUser.id, username: newUser.username, isAdmin: newUser.isAdmin } });
  } catch (err) {
    req.log.error(err, "register failed");
    res.status(500).json({ error: "注册失败，请稍后再试" });
  }
});

router.post("/auth/login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username?.trim() || !password) {
    res.status(400).json({ error: "请填写用户名和密码" }); return;
  }
  try {
    const [user] = await db.select().from(users).where(eq(users.username, username.trim())).limit(1);
    if (!user) { res.status(401).json({ error: "用户名或密码错误" }); return; }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) { res.status(401).json({ error: "用户名或密码错误" }); return; }

    const token = createToken({ userId: user.id, username: user.username, isAdmin: user.isAdmin });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ ok: true, user: { id: user.id, username: user.username, isAdmin: user.isAdmin } });
  } catch (err) {
    req.log.error(err, "login failed");
    res.status(500).json({ error: "登录失败，请稍后再试" });
  }
});

router.post("/auth/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, CLEAR_COOKIE_OPTS);
  res.json({ ok: true });
});

router.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
