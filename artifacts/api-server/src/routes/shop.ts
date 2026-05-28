import { Router } from "express";
import { db } from "@workspace/db";
import { cardKeys, users, shopConfig, shopOrders } from "@workspace/db";
import { eq, isNull, and, desc } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import { requireAuth, requireAdmin } from "../middleware/requireAuth";
import { cardTypeDurationMs, type CardType } from "../lib/auth";

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

function kkpaySign(base64Data: string, secret: string): string {
  return Buffer.from(
    createHash("sha256").update(base64Data + secret).digest()
  ).toString("base64");
}

async function getConfig() {
  const rows = await db.select().from(shopConfig).limit(1);
  return rows[0] ?? null;
}

async function tgApi(token: string, method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<{ ok: boolean; result?: unknown; description?: string }>;
}

async function tgSend(token: string, chatId: string | number, text: string, extra?: Record<string, unknown>) {
  return tgApi(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

async function fulfillOrder(orderId: string): Promise<{ ok: boolean; cardKey?: string; userId?: number; tgChatId?: string | null }> {
  const [order] = await db.select().from(shopOrders)
    .where(and(eq(shopOrders.orderId, orderId), eq(shopOrders.status, "pending")))
    .limit(1);
  if (!order) return { ok: false };

  const [card] = await db.select().from(cardKeys)
    .where(and(eq(cardKeys.type, order.cardType), isNull(cardKeys.userId)))
    .limit(1);
  if (!card) {
    await db.update(shopOrders).set({ status: "no_stock" }).where(eq(shopOrders.orderId, orderId));
    return { ok: false };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + cardTypeDurationMs(order.cardType as CardType));
  await db.update(cardKeys).set({ userId: order.userId, activatedAt: now, expiresAt }).where(eq(cardKeys.id, card.id));
  await db.update(shopOrders).set({ status: "delivered", cardKeyId: card.id, paidAt: now }).where(eq(shopOrders.orderId, orderId));

  return { ok: true, cardKey: card.key, userId: order.userId, tgChatId: order.tgChatId };
}

// ── Admin: get shop config ──────────────────────────────────────────────────

router.get("/admin/shop/config", requireAdmin, async (req, res) => {
  try {
    const cfg = await getConfig();
    res.json({
      kkpayId: cfg?.kkpayId ?? "",
      kkpaySecret: cfg?.kkpaySecret ?? "",
      domain: cfg?.domain ?? "",
      productName: cfg?.productName ?? "暗影飞投-卡密",
      priceDailyUsdt: cfg?.priceDailyUsdt ?? "1",
      priceWeeklyUsdt: cfg?.priceWeeklyUsdt ?? "5",
      priceMonthlyUsdt: cfg?.priceMonthlyUsdt ?? "15",
      enabled: cfg?.enabled ?? false,
      botToken: cfg?.botToken ?? "",
    });
  } catch (err) {
    req.log.error(err, "shop config get failed");
    res.status(500).json({ error: "查询失败" });
  }
});

// ── Admin: save shop config ─────────────────────────────────────────────────

router.post("/admin/shop/config", requireAdmin, async (req, res) => {
  const { kkpayId, kkpaySecret, domain, productName, priceDailyUsdt, priceWeeklyUsdt, priceMonthlyUsdt, enabled, botToken } = req.body as Record<string, string | boolean>;
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
      botToken: String(botToken ?? ""),
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

// ── Admin: setup TG bot webhook ─────────────────────────────────────────────

router.post("/admin/shop/setup-tg-bot", requireAdmin, async (req, res) => {
  try {
    const cfg = await getConfig();
    if (!cfg?.botToken) { res.status(400).json({ error: "请先填写并保存 Bot Token" }); return; }
    if (!cfg.domain) { res.status(400).json({ error: "请先填写并保存回调域名" }); return; }

    const webhookUrl = `${cfg.domain}/api/shop/tg-webhook`;
    const r = await tgApi(cfg.botToken, "setWebhook", { url: webhookUrl, drop_pending_updates: true });
    if (!r.ok) { res.status(502).json({ error: `Telegram 返回错误: ${r.description ?? "未知"}` }); return; }

    // Get bot info
    const me = await tgApi(cfg.botToken, "getMe", {});
    const username = (me.result as { username?: string } | undefined)?.username ?? "";
    res.json({ ok: true, webhookUrl, botUsername: username });
  } catch (err) {
    req.log.error(err, "setup tg bot failed");
    res.status(500).json({ error: "设置失败" });
  }
});

// ── Admin: list orders ──────────────────────────────────────────────────────

router.get("/admin/shop/orders", requireAdmin, async (req, res) => {
  try {
    const orders = await db.select().from(shopOrders).orderBy(desc(shopOrders.createdAt)).limit(200);
    const userMap: Record<number, string> = {};
    const ul = await db.select({ id: users.id, username: users.username }).from(users);
    for (const u of ul) userMap[u.id] = u.username;
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

// ── User: shop public status ────────────────────────────────────────────────

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
      hasBotToken: !!(cfg.botToken),
    });
  } catch {
    res.json({ enabled: false });
  }
});

// ── User: create web order ──────────────────────────────────────────────────

router.post("/shop/create-order", requireAuth, async (req, res) => {
  const { cardType } = req.body as { cardType?: string };
  if (!cardType || !["daily", "weekly", "monthly"].includes(cardType)) {
    res.status(400).json({ error: "卡密类型无效" }); return;
  }
  try {
    const cfg = await getConfig();
    if (!cfg?.enabled) { res.status(403).json({ error: "商店未开启" }); return; }
    const missing: string[] = [];
    if (!cfg.kkpayId) missing.push("KKPAY-ID");
    if (!cfg.kkpaySecret) missing.push("KKPAY-SECRET");
    if (!cfg.domain) missing.push("回调域名");
    if (missing.length > 0) {
      res.status(503).json({ error: `商店配置不完整，缺少：${missing.join("、")}，请联系管理员` }); return;
    }

    const priceMap: Record<string, string> = { daily: cfg.priceDailyUsdt, weekly: cfg.priceWeeklyUsdt, monthly: cfg.priceMonthlyUsdt };
    const typeLabel: Record<string, string> = { daily: "天卡", weekly: "周卡", monthly: "月卡" };
    const price = priceMap[cardType]!;
    const orderId = randomUUID();

    const payload = JSON.stringify({
      userOrder: orderId,
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
        headers: { "Content-Type": "text/plain", "KKPAY-ID": cfg.kkpayId, "KKPAY-SIGN": sign },
        body: base64Data,
      });
      payUrl = await r.text();
    } catch (e) {
      req.log.error(e, "kkpay paylink failed");
      res.status(502).json({ error: "支付接口请求失败，请稍后再试" }); return;
    }

    if (!payUrl.startsWith("http")) {
      res.status(502).json({ error: `支付接口返回异常: ${payUrl}` }); return;
    }

    await db.insert(shopOrders).values({ orderId, userId: req.user!.userId, cardType, amountUsdt: price, status: "pending", payUrl });
    res.json({ ok: true, orderId, payUrl });
  } catch (err) {
    req.log.error(err, "create order failed");
    res.status(500).json({ error: "创建订单失败" });
  }
});

// ── User: poll order status ─────────────────────────────────────────────────

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

// ── KKPay notify callback (public) ─────────────────────────────────────────

router.post("/shop/notify", async (req, res) => {
  try {
    const data = req.body as Record<string, string>;
    const orderId = data["userOrder"] ?? data["unique_id"];
    const status = data["status"];
    if (!orderId || status !== "success") { res.json({ status: "ignored" }); return; }

    const result = await fulfillOrder(orderId);
    if (!result.ok || !result.cardKey) { res.json({ status: result.ok ? "ok" : "failed" }); return; }

    // Send via TG bot if order came from bot
    if (result.tgChatId) {
      try {
        const cfg = await getConfig();
        if (cfg?.botToken) {
          const typeLabel: Record<string, string> = { daily: "天卡", weekly: "周卡", monthly: "月卡" };
          const [order] = await db.select().from(shopOrders).where(eq(shopOrders.orderId, orderId)).limit(1);
          const label = order ? (typeLabel[order.cardType] ?? order.cardType) : "";
          await tgSend(cfg.botToken, result.tgChatId,
            `✅ 支付成功！\n\n🎁 你的${label}卡密：\n\n<code>${result.cardKey}</code>\n\n请前往平台激活使用。`
          );
        }
      } catch { /* ignore TG send failure, card is already activated */ }
    }

    res.json({ status: "success" });
  } catch (err) {
    console.error("shop notify error", err);
    res.status(500).json({ status: "error" });
  }
});

// ── TG Bot webhook (public) ─────────────────────────────────────────────────

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; message?: { chat: { id: number }; message_id: number }; data?: string };
}

router.post("/shop/tg-webhook", async (req, res) => {
  // Always acknowledge immediately
  res.json({ ok: true });

  const update = req.body as TgUpdate;
  try {
    const cfg = await getConfig();
    if (!cfg?.botToken || !cfg.enabled) return;
    const token = cfg.botToken;

    const typeLabel: Record<string, string> = { daily: "天卡", weekly: "周卡", monthly: "月卡" };
    const priceMap: Record<string, string> = { daily: cfg.priceDailyUsdt, weekly: cfg.priceWeeklyUsdt, monthly: cfg.priceMonthlyUsdt };

    // Build the main menu keyboard
    const menuKeyboard = {
      inline_keyboard: [
        [
          { text: `☀️ 天卡 ${cfg.priceDailyUsdt}U`, callback_data: "buy:daily" },
          { text: `⭐ 周卡 ${cfg.priceWeeklyUsdt}U`, callback_data: "buy:weekly" },
          { text: `👑 月卡 ${cfg.priceMonthlyUsdt}U`, callback_data: "buy:monthly" },
        ],
      ],
    };

    // Handle /start or text
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = (update.message.text ?? "").trim();

      if (text.startsWith("/start")) {
        await tgSend(token, chatId,
          `🌑 <b>暗影飞投 - 卡密商店</b>\n\n选择要购买的卡密类型：\n\n☀️ 天卡 — ${cfg.priceDailyUsdt} USDT · 1天\n⭐ 周卡 — ${cfg.priceWeeklyUsdt} USDT · 7天\n👑 月卡 — ${cfg.priceMonthlyUsdt} USDT · 30天\n\n支持 USDT 支付，付款后自动发卡。`,
          { reply_markup: menuKeyboard }
        );
      } else {
        await tgSend(token, chatId, "请点击按钮选择购买的卡密类型 👇", { reply_markup: menuKeyboard });
      }
      return;
    }

    // Handle button press
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat.id;
      const data = cq.data ?? "";

      // Ack the button press
      await tgApi(token, "answerCallbackQuery", { callback_query_id: cq.id });

      if (!data.startsWith("buy:") || !chatId) return;
      const cardType = data.replace("buy:", "");
      if (!["daily", "weekly", "monthly"].includes(cardType)) return;

      if (!cfg.kkpayId || !cfg.kkpaySecret || !cfg.domain) {
        await tgSend(token, chatId, "⚠️ 商店暂时无法使用，请联系管理员。");
        return;
      }

      // Find or create a platform user for this TG ID (use tgChatId as username seed)
      // For bot orders we store userId=0 (system) and deliver via tgChatId
      const tgUserId = String(cq.from.id);
      const orderId = randomUUID();
      const price = priceMap[cardType]!;

      const payload = JSON.stringify({
        userOrder: orderId,
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
          headers: { "Content-Type": "text/plain", "KKPAY-ID": cfg.kkpayId, "KKPAY-SIGN": sign },
          body: base64Data,
        });
        payUrl = await r.text();
      } catch {
        await tgSend(token, chatId, "❌ 支付接口暂时不可用，请稍后重试。");
        return;
      }

      if (!payUrl.startsWith("http")) {
        await tgSend(token, chatId, `❌ 支付接口返回异常，请联系管理员。\n\n${payUrl}`);
        return;
      }

      // Use tgUserId as a placeholder userId for bot orders (store as -tgChatId to not conflict)
      // We'll look up or create a mapping. Simplest: userId=1 (admin), deliver only via tgChatId
      // Find first admin user id as fulfillment owner
      const [adminUser] = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).limit(1);
      const ownerUserId = adminUser?.id ?? 1;

      await db.insert(shopOrders).values({
        orderId,
        userId: ownerUserId,
        cardType,
        amountUsdt: price,
        status: "pending",
        payUrl,
        tgChatId: String(chatId),
      });

      await tgSend(token, chatId,
        `💳 <b>${typeLabel[cardType]} — ${price} USDT</b>\n\n点击下方链接完成支付：\n${payUrl}\n\n⏰ 支付成功后将自动发送卡密到此对话。`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "💳 立即支付", url: payUrl }]],
          },
        }
      );

      // Also send TG user ID hint for record
      console.info(`[shop-bot] order ${orderId} created for tg:${tgUserId} chat:${chatId} type:${cardType}`);
    }
  } catch (err) {
    console.error("tg-webhook error", err);
  }
});

export default router;
