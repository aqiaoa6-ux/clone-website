import { Router } from "express";
import { db } from "@workspace/db";
import { cardKeys, users, shopConfig, shopOrders } from "@workspace/db";
import { eq, isNull, and, desc } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import { requireAuth, requireAdmin } from "../middleware/requireAuth";
import { cardTypeDurationMs, type CardType } from "../lib/auth";

const router = Router();

function kkpaySign(base64Data: string, secret: string): string {
  return Buffer.from(
    createHash("sha256").update(base64Data + secret).digest()
  ).toString("base64");
}

async function getConfig() {
  const rows = await db.select().from(shopConfig).limit(1);
  return rows[0] ?? null;
}

// ── Admin: get shop config ──
router.get("/admin/shop/config", requireAdmin, async (req, res) => {
  try {
    const cfg = await getConfig();
    if (!cfg) {
      res.json({
        kkpayId: "", kkpaySecret: "", domain: "",
        productName: "暗影飞投-卡密",
        priceDailyUsdt: "1", priceWeeklyUsdt: "5", priceMonthlyUsdt: "15",
        enabled: false,
      });
      return;
    }
    res.json({
      kkpayId: cfg.kkpayId,
      kkpaySecret: cfg.kkpaySecret,
      domain: cfg.domain,
      productName: cfg.productName,
      priceDailyUsdt: cfg.priceDailyUsdt,
      priceWeeklyUsdt: cfg.priceWeeklyUsdt,
      priceMonthlyUsdt: cfg.priceMonthlyUsdt,
      enabled: cfg.enabled,
    });
  } catch (err) {
    req.log.error(err, "shop config get failed");
    res.status(500).json({ error: "查询失败" });
  }
});

// ── Admin: save shop config ──
router.post("/admin/shop/config", requireAdmin, async (req, res) => {
  const { kkpayId, kkpaySecret, domain, productName, priceDailyUsdt, priceWeeklyUsdt, priceMonthlyUsdt, enabled } = req.body as Record<string, string | boolean>;
  try {
    const existing = await getConfig();
    const values = {
      kkpayId: String(kkpayId ?? ""),
      kkpaySecret: String(kkpaySecret ?? ""),
      domain: String(domain ?? "").replace(/\/$/, ""),
      productName: String(productName ?? "暗影飞投-卡密"),
      priceDailyUsdt: String(priceDailyUsdt ?? "1"),
      priceWeeklyUsdt: String(priceWeeklyUsdt ?? "5"),
      priceMonthlyUsdt: String(priceMonthlyUsdt ?? "15"),
      enabled: Boolean(enabled),
      updatedAt: new Date(),
    };
    if (existing) {
      await db.update(shopConfig).set(values).where(eq(shopConfig.id, existing.id));
    } else {
      await db.insert(shopConfig).values(values);
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "shop config save failed");
    res.status(500).json({ error: "保存失败" });
  }
});

// ── Admin: list orders ──
router.get("/admin/shop/orders", requireAdmin, async (req, res) => {
  try {
    const orders = await db.select().from(shopOrders).orderBy(desc(shopOrders.createdAt)).limit(200);
    const userIds = [...new Set(orders.map(o => o.userId))];
    const userMap: Record<number, string> = {};
    if (userIds.length > 0) {
      const ul = await db.select({ id: users.id, username: users.username }).from(users);
      for (const u of ul) userMap[u.id] = u.username;
    }
    res.json({
      orders: orders.map(o => ({
        ...o,
        username: userMap[o.userId] ?? `用户${o.userId}`,
        createdAt: o.createdAt.toISOString(),
        paidAt: o.paidAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    req.log.error(err, "shop orders failed");
    res.status(500).json({ error: "查询失败" });
  }
});

// ── Admin: get shop status (public summary for user side) ──
router.get("/shop/status", requireAuth, async (req, res) => {
  try {
    const cfg = await getConfig();
    if (!cfg?.enabled) { res.json({ enabled: false }); return; }
    res.json({
      enabled: true,
      productName: cfg.productName,
      priceDailyUsdt: cfg.priceDailyUsdt,
      priceWeeklyUsdt: cfg.priceWeeklyUsdt,
      priceMonthlyUsdt: cfg.priceMonthlyUsdt,
    });
  } catch {
    res.json({ enabled: false });
  }
});

// ── User: create order → returns KKPay payment URL ──
router.post("/shop/create-order", requireAuth, async (req, res) => {
  const { cardType } = req.body as { cardType?: string };
  if (!cardType || !["daily", "weekly", "monthly"].includes(cardType)) {
    res.status(400).json({ error: "卡密类型无效" }); return;
  }
  try {
    const cfg = await getConfig();
    if (!cfg?.enabled) { res.status(403).json({ error: "商店未开启" }); return; }
    if (!cfg.kkpayId || !cfg.kkpaySecret || !cfg.domain) {
      res.status(503).json({ error: "商店配置不完整" }); return;
    }

    const priceMap: Record<string, string> = {
      daily: cfg.priceDailyUsdt,
      weekly: cfg.priceWeeklyUsdt,
      monthly: cfg.priceMonthlyUsdt,
    };
    const typeLabel: Record<string, string> = { daily: "天卡", weekly: "周卡", monthly: "月卡" };
    const price = priceMap[cardType]!;
    const orderId = randomUUID();

    // Call KKPay payLink
    const payload = JSON.stringify({
      unique_id: orderId,
      name: `${cfg.productName}-${typeLabel[cardType]}`,
      amount: price,
      coin: "USDT",
      notify_url: `${cfg.domain}/api/shop/notify`,
    });
    const base64Data = Buffer.from(payload).toString("base64");
    const sign = kkpaySign(base64Data, cfg.kkpaySecret);

    let payUrl = "";
    try {
      const r = await fetch("https://api.kkpaywallet.com/merchant/payLink", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "KKPAY-ID": cfg.kkpayId,
          "KKPAY-SIGN": sign,
        },
        body: base64Data,
      });
      payUrl = await r.text();
    } catch (e) {
      req.log.error(e, "kkpay paylink failed");
      res.status(502).json({ error: "支付接口请求失败，请稍后再试" }); return;
    }

    if (!payUrl.startsWith("http")) {
      req.log.warn({ payUrl }, "kkpay returned non-url");
      res.status(502).json({ error: `支付接口返回异常: ${payUrl}` }); return;
    }

    await db.insert(shopOrders).values({
      orderId,
      userId: req.user!.userId,
      cardType,
      amountUsdt: price,
      status: "pending",
      payUrl,
    });

    res.json({ ok: true, orderId, payUrl });
  } catch (err) {
    req.log.error(err, "create order failed");
    res.status(500).json({ error: "创建订单失败" });
  }
});

// ── User: poll order status ──
router.get("/shop/order/:orderId", requireAuth, async (req, res) => {
  try {
    const orderId = String(req.params["orderId"] ?? "");
    const [order] = await db.select().from(shopOrders)
      .where(and(eq(shopOrders.orderId, orderId), eq(shopOrders.userId, req.user!.userId)))
      .limit(1);
    if (!order) { res.status(404).json({ error: "订单不存在" }); return; }
    res.json({ status: order.status, cardType: order.cardType, paidAt: order.paidAt?.toISOString() ?? null });
  } catch {
    res.status(500).json({ error: "查询失败" });
  }
});

// ── KKPay notify callback (public) ──
router.post("/shop/notify", async (req, res) => {
  try {
    const data = req.body as Record<string, string>;
    const orderId = data["unique_id"];
    const status = data["status"];

    if (!orderId || status !== "success") {
      res.json({ status: "ignored" }); return;
    }

    const [order] = await db.select().from(shopOrders)
      .where(and(eq(shopOrders.orderId, orderId), eq(shopOrders.status, "pending")))
      .limit(1);
    if (!order) { res.json({ status: "order_not_found" }); return; }

    // Find unused card of the correct type
    const [card] = await db.select().from(cardKeys)
      .where(and(eq(cardKeys.type, order.cardType), isNull(cardKeys.userId)))
      .limit(1);

    if (!card) {
      await db.update(shopOrders).set({ status: "no_stock" }).where(eq(shopOrders.orderId, orderId));
      res.json({ status: "no_stock" }); return;
    }

    const now = new Date();
    const durationMs = cardTypeDurationMs(order.cardType as CardType);
    const expiresAt = new Date(now.getTime() + durationMs);

    await db.update(cardKeys)
      .set({ userId: order.userId, activatedAt: now, expiresAt })
      .where(eq(cardKeys.id, card.id));

    await db.update(shopOrders)
      .set({ status: "delivered", cardKeyId: card.id, paidAt: now })
      .where(eq(shopOrders.orderId, orderId));

    res.json({ status: "success" });
  } catch (err) {
    console.error("shop notify error", err);
    res.status(500).json({ status: "error" });
  }
});

export default router;
