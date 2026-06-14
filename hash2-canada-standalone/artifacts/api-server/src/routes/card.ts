import { Router } from "express";
import { db } from "@workspace/db";
import { cardKeys } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import { requireAuth } from "../middleware/requireAuth";
import { cardTypeDurationMs, type CardType } from "../lib/auth";
import { ensureCardKeysTable } from "../lib/ensureTables";

const router = Router();

router.get("/card/status", requireAuth, async (req, res) => {
  try {
    await ensureCardKeysTable();
    const now = new Date();
    const rows = await db.select().from(cardKeys)
      .where(eq(cardKeys.userId, req.user!.userId));

    // Find the one with the latest expiry (most valuable active card)
    const active = rows
      .filter(c => c.expiresAt && c.expiresAt > now)
      .sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0];

    if (!active) {
      const anyExpired = rows.find(c => c.expiresAt && c.expiresAt <= now);
      res.json({ active: false, expired: !!anyExpired });
      return;
    }
    res.json({ active: true, type: active.type, expiresAt: active.expiresAt!.toISOString(), key: active.key });
  } catch (err) {
    req.log.error(err, "card status failed");
    res.status(500).json({ error: "查询失败" });
  }
});

router.post("/card/activate", requireAuth, async (req, res) => {
  const { key } = req.body as { key?: string };
  if (!key?.trim()) { res.status(400).json({ error: "请输入卡密" }); return; }

  const normalizedKey = key.trim().toUpperCase();
  try {
    await ensureCardKeysTable();
    const [card] = await db.select().from(cardKeys).where(eq(cardKeys.key, normalizedKey)).limit(1);
    if (!card) { res.status(400).json({ error: "卡密不存在" }); return; }
    if (card.userId !== null && card.userId !== req.user!.userId) {
      res.status(400).json({ error: "此卡密已被他人使用" }); return;
    }

    const now = new Date();
    if (card.userId === req.user!.userId && card.expiresAt && card.expiresAt > now) {
      res.json({ ok: true, type: card.type, expiresAt: card.expiresAt.toISOString() });
      return;
    }

    const durationMs = cardTypeDurationMs(card.type as CardType);
    const expiresAt = new Date(now.getTime() + durationMs);

    await db.update(cardKeys)
      .set({ userId: req.user!.userId, activatedAt: now, expiresAt })
      .where(eq(cardKeys.id, card.id));

    res.json({ ok: true, type: card.type, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    req.log.error(err, "card activate failed");
    res.status(500).json({ error: "激活失败，请稍后再试" });
  }
});

export default router;
