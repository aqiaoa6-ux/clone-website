import { Router } from "express";
import { db } from "@workspace/db";
import { cardKeys, users } from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";
import { requireAdmin, requireAdminSecret } from "../middleware/requireAuth";
import {
  generateCardKey,
  hashPassword,
  verifyPassword,
  createAdminSecretToken,
  ADMIN_SECRET_COOKIE_OPTS,
  CLEAR_ADMIN_SECRET_COOKIE_OPTS,
  ADMIN_SECRET_COOKIE,
} from "../lib/auth";

const router = Router();

// ── 后台二级密码接口（无需 adminSecret，只需 admin 身份） ─────────────────

/** 检查当前是否已设置后台密码 + 是否已验证 */
router.get("/admin/auth/status", requireAdmin, (req, res) => {
  const cookies = req.cookies as Record<string, string>;
  res.json({ hasSecret: true, verified: !!cookies[ADMIN_SECRET_COOKIE] });
});

/** 验证后台密码，通过后写入短效 cookie（2小时） */
router.post("/admin/auth/verify", requireAdmin, async (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password) { res.status(400).json({ error: "密码不能为空" }); return; }

  const [user] = await db.select({ adminSecretHash: users.adminSecretHash })
    .from(users).where(eq(users.id, req.user!.userId));

  if (!user) { res.status(404).json({ error: "用户不存在" }); return; }

  if (!user.adminSecretHash) {
    // 尚未设置后台密码：首次验证直接通过并保存
    const hash = await hashPassword(password);
    await db.update(users).set({ adminSecretHash: hash }).where(eq(users.id, req.user!.userId));
    const token = createAdminSecretToken(req.user!.userId);
    res.cookie(ADMIN_SECRET_COOKIE, token, ADMIN_SECRET_COOKIE_OPTS);
    res.json({ ok: true, firstTime: true });
    return;
  }

  const ok = await verifyPassword(password, user.adminSecretHash);
  if (!ok) { res.status(401).json({ error: "后台密码错误" }); return; }

  const token = createAdminSecretToken(req.user!.userId);
  res.cookie(ADMIN_SECRET_COOKIE, token, ADMIN_SECRET_COOKIE_OPTS);
  res.json({ ok: true });
});

/** 修改后台密码（需已验证） */
router.post("/admin/auth/change", requireAdminSecret, async (req, res) => {
  const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string };
  if (!oldPassword || !newPassword) { res.status(400).json({ error: "新旧密码均不能为空" }); return; }
  if (newPassword.length < 6) { res.status(400).json({ error: "新密码至少6位" }); return; }

  const [user] = await db.select({ adminSecretHash: users.adminSecretHash })
    .from(users).where(eq(users.id, req.user!.userId));

  if (user?.adminSecretHash) {
    const ok = await verifyPassword(oldPassword, user.adminSecretHash);
    if (!ok) { res.status(401).json({ error: "旧密码错误" }); return; }
  }

  const hash = await hashPassword(newPassword);
  await db.update(users).set({ adminSecretHash: hash }).where(eq(users.id, req.user!.userId));
  // 重新签发 token
  const token = createAdminSecretToken(req.user!.userId);
  res.cookie(ADMIN_SECRET_COOKIE, token, ADMIN_SECRET_COOKIE_OPTS);
  res.json({ ok: true });
});

/** 退出后台验证（清除 admin_secret cookie） */
router.post("/admin/auth/logout", requireAdmin, (_req, res) => {
  res.clearCookie(ADMIN_SECRET_COOKIE, CLEAR_ADMIN_SECRET_COOKIE_OPTS);
  res.json({ ok: true });
});

// ── 卡密管理（需后台密码验证） ────────────────────────────────────────────

router.post("/admin/cards/generate", requireAdminSecret, async (req, res) => {
  const { type, count, note } = req.body as { type?: string; count?: number; note?: string };
  if (!type || !["daily", "weekly", "monthly"].includes(type)) {
    res.status(400).json({ error: "卡密类型无效（daily/weekly/monthly）" }); return;
  }
  const qty = Math.min(Math.max(1, Number(count) || 1), 100);
  try {
    const generated: string[] = [];
    for (let i = 0; i < qty; i++) {
      let key = generateCardKey();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await db.insert(cardKeys).values({ key, type, note: note ?? null });
          generated.push(key);
          break;
        } catch {
          key = generateCardKey();
        }
      }
    }
    res.json({ ok: true, keys: generated });
  } catch (err) {
    req.log.error(err, "generate cards failed");
    res.status(500).json({ error: "生成失败" });
  }
});

router.get("/admin/cards", requireAdminSecret, async (req, res) => {
  try {
    const cards = await db.select().from(cardKeys).orderBy(desc(cardKeys.createdAt)).limit(500);
    const userIds = [...new Set(cards.filter(c => c.userId !== null).map(c => c.userId!))];
    const userMap: Record<number, string> = {};
    if (userIds.length > 0) {
      const userList = await db.select({ id: users.id, username: users.username })
        .from(users).where(inArray(users.id, userIds));
      for (const u of userList) userMap[u.id] = u.username;
    }
    const now = new Date();
    res.json({
      cards: cards.map(c => ({
        ...c,
        username: c.userId ? (userMap[c.userId] ?? null) : null,
        isActive: !!(c.expiresAt && c.expiresAt > now),
        isUsed: c.userId !== null,
      })),
    });
  } catch (err) {
    req.log.error(err, "list cards failed");
    res.status(500).json({ error: "查询失败" });
  }
});

router.delete("/admin/cards/:id", requireAdminSecret, async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? ""));
  if (isNaN(id)) { res.status(400).json({ error: "无效 ID" }); return; }
  try {
    await db.delete(cardKeys).where(eq(cardKeys.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "delete card failed");
    res.status(500).json({ error: "删除失败" });
  }
});

router.get("/admin/users", requireAdminSecret, async (_req, res) => {
  try {
    const allUsers = await db.select({ id: users.id, username: users.username, isAdmin: users.isAdmin, createdAt: users.createdAt })
      .from(users).orderBy(desc(users.createdAt));
    res.json({ users: allUsers });
  } catch (err) {
    res.status(500).json({ error: "查询失败" });
  }
});

router.post("/admin/users/:id/set-admin", requireAdminSecret, async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? ""));
  if (isNaN(id)) { res.status(400).json({ error: "无效用户 ID" }); return; }
  const { isAdmin } = req.body as { isAdmin?: boolean };
  if (typeof isAdmin !== "boolean") { res.status(400).json({ error: "isAdmin 必须为 boolean" }); return; }
  try {
    await db.update(users).set({ isAdmin }).where(eq(users.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "set-admin failed");
    res.status(500).json({ error: "操作失败" });
  }
});

export default router;
