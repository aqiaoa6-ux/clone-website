import { Router } from "express";
import { db } from "@workspace/db";
import { cardKeys, users } from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";
import { requireAdmin } from "../middleware/requireAuth";
import { generateCardKey } from "../lib/auth";

const router = Router();

router.post("/admin/cards/generate", requireAdmin, async (req, res) => {
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

router.get("/admin/cards", requireAdmin, async (req, res) => {
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

router.delete("/admin/cards/:id", requireAdmin, async (req, res) => {
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

router.get("/admin/users", requireAdmin, async (_req, res) => {
  try {
    const allUsers = await db.select({ id: users.id, username: users.username, isAdmin: users.isAdmin, createdAt: users.createdAt })
      .from(users).orderBy(desc(users.createdAt));
    res.json({ users: allUsers });
  } catch (err) {
    res.status(500).json({ error: "查询失败" });
  }
});

export default router;
