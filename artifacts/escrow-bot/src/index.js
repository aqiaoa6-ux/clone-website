import "dotenv/config";
import { Telegraf, Markup, session } from "telegraf";
import crypto from "crypto";
import { loadStore, saveStore } from "./store.js";
import { formatMoney, formatOrderStatus, formatUserStats } from "./format.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = parseAdminIds(process.env.ADMIN_IDS ?? "");

if (!BOT_TOKEN) {
  process.stderr.write("Missing BOT_TOKEN in environment\n");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const store = await loadStore();

function parseAdminIds(raw) {
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => Number(s))
    .filter(n => Number.isInteger(n) && n > 0);
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

function nowMs() {
  return Date.now();
}

function getOrInitUserStats(userId) {
  const key = String(userId);
  const existing = store.users[key];
  if (existing && typeof existing === "object") return existing;
  const fresh = { total: 0, success: 0, cancelled: 0 };
  store.users[key] = fresh;
  return fresh;
}

function newBindToken() {
  return crypto.randomBytes(16).toString("hex");
}

function newOrderId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function getOrder(orderId) {
  return store.orders[String(orderId)] ?? null;
}

function activeOrderIdForUser(userId) {
  return store.binds[String(userId)] ?? null;
}

function otherRole(role) {
  return role === "buyer" ? "seller" : "buyer";
}

function canChat(order) {
  return order && (order.status === "waiting_payment" || order.status === "paid_waiting_release" || order.status === "frozen");
}

function buildOrderText(order) {
  const buyerName = order.buyer?.name ?? "未绑定";
  const sellerName = order.seller?.name ?? "未绑定";
  const buyerId = order.buyer?.id ?? "—";
  const sellerId = order.seller?.id ?? "—";
  const amountStr = formatMoney(order.amount, order.currency);
  const buyerStats = order.buyer?.id ? formatUserStats(getOrInitUserStats(order.buyer.id)) : "—";
  const sellerStats = order.seller?.id ? formatUserStats(getOrInitUserStats(order.seller.id)) : "—";
  const statusStr = formatOrderStatus(order.status);
  return [
    `当前订单号： ${order.id}`,
    `交易金额： ${amountStr}`,
    `买家： ${buyerName} (${buyerId})`,
    `卖家： ${sellerName} (${sellerId})`,
    "",
    `买家信息： ${buyerStats}`,
    `卖家信息： ${sellerStats}`,
    "",
    `订单状态： ${statusStr}`,
    "",
    "机器人会保存双方私聊内容作为交易凭证，用于纠纷处理。",
    "不处理口令纠纷，不要口令付款。请全程保留截图/录屏。"
  ].join("\n");
}

function buildOrderKeyboard(order, viewerId) {
  const viewerRole =
    order.buyer?.id === viewerId ? "buyer" : order.seller?.id === viewerId ? "seller" : null;
  const rows = [];

  if (viewerRole === "buyer" && order.status === "waiting_payment") {
    rows.push([Markup.button.callback("✅ 我已付款，请放币(买方)", `paid:${order.id}`)]);
    rows.push([Markup.button.callback("⭕ 不想买了，取消交易(买方)", `cancel:${order.id}`)]);
  }

  if (viewerRole === "seller" && order.status === "paid_waiting_release") {
    rows.push([Markup.button.callback("✅ 我已确认收款/放币(卖方)", `release:${order.id}`)]);
  }

  if (viewerRole && order.status === "frozen") {
    rows.push([Markup.button.callback("🔔 申请管理员介入", `ping_admin:${order.id}`)]);
  }

  if (isAdmin(viewerId)) {
    rows.push([
      Markup.button.callback("🙅 取消订单(管理员)", `admin_cancel:${order.id}`),
      Markup.button.callback("🙆 确认放币(管理员)", `admin_release:${order.id}`)
    ]);
  }

  rows.push([Markup.button.callback("📄 刷新订单", `refresh:${order.id}`)]);
  return Markup.inlineKeyboard(rows);
}

async function sendOrUpdateOrder(ctx, order, opts = {}) {
  const viewerId = ctx.from?.id;
  if (!viewerId) return;
  const text = buildOrderText(order);
  const keyboard = buildOrderKeyboard(order, viewerId);

  if (opts.editMessage && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, keyboard);
      return;
    } catch {}
  }

  await ctx.reply(text, keyboard);
}

async function notifyAdmins(order, reason) {
  const text = [
    "管理员提示：有新订单/需要介入",
    `原因：${reason}`,
    "",
    buildOrderText(order)
  ].join("\n");
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, text, buildOrderKeyboard(order, adminId));
    } catch {}
  }
}

function ensureOrderStatsFinalized(order, finalStatus) {
  if (order.finalized) return;
  if (finalStatus === "completed") {
    if (order.buyer?.id) {
      const s = getOrInitUserStats(order.buyer.id);
      s.total += 1;
      s.success += 1;
    }
    if (order.seller?.id) {
      const s = getOrInitUserStats(order.seller.id);
      s.total += 1;
      s.success += 1;
    }
  }
  if (finalStatus === "cancelled") {
    if (order.buyer?.id) {
      const s = getOrInitUserStats(order.buyer.id);
      s.total += 1;
      s.cancelled += 1;
    }
    if (order.seller?.id) {
      const s = getOrInitUserStats(order.seller.id);
      s.total += 1;
      s.cancelled += 1;
    }
  }
  order.finalized = true;
}

async function setActiveOrderForUser(userId, orderId) {
  store.binds[String(userId)] = String(orderId);
  await saveStore(store);
}

async function clearActiveOrderForUser(userId) {
  delete store.binds[String(userId)];
  await saveStore(store);
}

async function flushPendingMessages(order, targetUserId, targetRole) {
  const pending = Array.isArray(order.pendingMessages) ? order.pendingMessages : [];
  const remain = [];
  for (const item of pending) {
    if (!item || item.toRole !== targetRole || item.toUserId) {
      remain.push(item);
      continue;
    }
    try {
      await bot.telegram.copyMessage(
        targetUserId,
        item.fromUserId,
        item.messageId
      );
    } catch {}
  }
  order.pendingMessages = remain;
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ 创建订单", "menu:new")],
    [Markup.button.callback("🔗 绑定订单", "menu:bind")],
    [Markup.button.callback("📄 查看当前订单", "menu:current")]
  ]);
}

bot.start(async ctx => {
  await ctx.reply(
    "发送 /new 创建订单，或点击下面菜单。\n双方都需要先 /start 机器人，否则无法收发消息。",
    mainMenu()
  );
});

bot.command("new", async ctx => {
  ctx.session = { step: "new" };
  await ctx.reply("请输入交易金额与币种，例如：30 CNY 或 100 USDT");
});

bot.command("bind", async ctx => {
  const parts = String(ctx.message?.text ?? "").trim().split(/\s+/);
  const code = parts.slice(1).join(" ").trim();
  if (!code) {
    ctx.session = { step: "bind" };
    await ctx.reply("请发送绑定码（创建订单后生成的 buyer:... 或 seller:...）");
    return;
  }
  await handleBindCode(ctx, code);
});

bot.command("order", async ctx => {
  const parts = String(ctx.message?.text ?? "").trim().split(/\s+/);
  const id = parts[1];
  const order = id ? getOrder(id) : null;
  if (!order) {
    await ctx.reply("订单不存在。用 /order <订单号> 查看。");
    return;
  }
  await sendOrUpdateOrder(ctx, order);
});

bot.on("callback_query", async ctx => {
  const data = String(ctx.callbackQuery?.data ?? "");
  const [action, orderId] = data.split(":");
  if (data === "menu:new") {
    ctx.session = { step: "new" };
    await ctx.answerCbQuery();
    await ctx.reply("请输入交易金额与币种，例如：30 CNY 或 100 USDT");
    return;
  }
  if (data === "menu:bind") {
    ctx.session = { step: "bind" };
    await ctx.answerCbQuery();
    await ctx.reply("请发送绑定码（创建订单后生成的 buyer:... 或 seller:...）");
    return;
  }
  if (data === "menu:current") {
    await ctx.answerCbQuery();
    const current = activeOrderIdForUser(ctx.from.id);
    const order = current ? getOrder(current) : null;
    if (!order) {
      await ctx.reply("你当前没有绑定中的订单。");
      return;
    }
    await sendOrUpdateOrder(ctx, order);
    return;
  }

  const order = orderId ? getOrder(orderId) : null;
  if (!order) {
    await ctx.answerCbQuery("订单不存在", { show_alert: true });
    return;
  }

  const viewerId = ctx.from?.id;
  if (!viewerId) return;

  if (action === "refresh") {
    await ctx.answerCbQuery();
    await sendOrUpdateOrder(ctx, order, { editMessage: true });
    return;
  }

  if (action === "ping_admin") {
    await ctx.answerCbQuery("已通知管理员");
    await notifyAdmins(order, "用户申请介入");
    return;
  }

  if (action === "paid") {
    if (order.buyer?.id !== viewerId) {
      await ctx.answerCbQuery("仅买家可操作", { show_alert: true });
      return;
    }
    if (order.status !== "waiting_payment") {
      await ctx.answerCbQuery("当前状态不可操作", { show_alert: true });
      return;
    }
    order.status = "paid_waiting_release";
    order.paidAt = nowMs();
    await saveStore(store);
    await ctx.answerCbQuery("已标记付款");
    if (order.seller?.id) {
      await bot.telegram.sendMessage(order.seller.id, "买家已标记付款，请核对收款并确认放币。");
    }
    await sendOrUpdateOrder(ctx, order, { editMessage: true });
    return;
  }

  if (action === "release") {
    if (order.seller?.id !== viewerId) {
      await ctx.answerCbQuery("仅卖家可操作", { show_alert: true });
      return;
    }
    if (order.status !== "paid_waiting_release") {
      await ctx.answerCbQuery("当前状态不可操作", { show_alert: true });
      return;
    }
    order.status = "completed";
    order.completedAt = nowMs();
    ensureOrderStatsFinalized(order, "completed");
    await saveStore(store);
    await ctx.answerCbQuery("订单已完成");
    if (order.buyer?.id) await clearActiveOrderForUser(order.buyer.id);
    if (order.seller?.id) await clearActiveOrderForUser(order.seller.id);
    await sendOrUpdateOrder(ctx, order, { editMessage: true });
    return;
  }

  if (action === "cancel") {
    if (order.buyer?.id !== viewerId) {
      await ctx.answerCbQuery("仅买家可操作", { show_alert: true });
      return;
    }
    if (order.status === "completed" || order.status === "cancelled") {
      await ctx.answerCbQuery("订单已结束", { show_alert: true });
      return;
    }
    order.status = "cancelled";
    order.cancelledAt = nowMs();
    ensureOrderStatsFinalized(order, "cancelled");
    await saveStore(store);
    await ctx.answerCbQuery("已取消订单");
    if (order.buyer?.id) await clearActiveOrderForUser(order.buyer.id);
    if (order.seller?.id) await clearActiveOrderForUser(order.seller.id);
    if (order.seller?.id) {
      await bot.telegram.sendMessage(order.seller.id, "买家已取消订单。");
    }
    await sendOrUpdateOrder(ctx, order, { editMessage: true });
    return;
  }

  if (action === "admin_cancel" || action === "admin_release") {
    if (!isAdmin(viewerId)) {
      await ctx.answerCbQuery("无权限", { show_alert: true });
      return;
    }
    if (action === "admin_cancel") {
      if (order.status === "completed" || order.status === "cancelled") {
        await ctx.answerCbQuery("订单已结束", { show_alert: true });
        return;
      }
      order.status = "cancelled";
      order.cancelledAt = nowMs();
      ensureOrderStatsFinalized(order, "cancelled");
      await saveStore(store);
      await ctx.answerCbQuery("已管理员取消");
      if (order.buyer?.id) await clearActiveOrderForUser(order.buyer.id);
      if (order.seller?.id) await clearActiveOrderForUser(order.seller.id);
      if (order.buyer?.id) await bot.telegram.sendMessage(order.buyer.id, "管理员已取消订单。");
      if (order.seller?.id) await bot.telegram.sendMessage(order.seller.id, "管理员已取消订单。");
      await sendOrUpdateOrder(ctx, order, { editMessage: true });
      return;
    }
    if (action === "admin_release") {
      order.status = "completed";
      order.completedAt = nowMs();
      ensureOrderStatsFinalized(order, "completed");
      await saveStore(store);
      await ctx.answerCbQuery("已管理员完成");
      if (order.buyer?.id) await clearActiveOrderForUser(order.buyer.id);
      if (order.seller?.id) await clearActiveOrderForUser(order.seller.id);
      if (order.buyer?.id) await bot.telegram.sendMessage(order.buyer.id, "管理员已标记订单完成。");
      if (order.seller?.id) await bot.telegram.sendMessage(order.seller.id, "管理员已标记订单完成。");
      await sendOrUpdateOrder(ctx, order, { editMessage: true });
      return;
    }
  }

  await ctx.answerCbQuery();
});

bot.on("message", async ctx => {
  const text = "text" in ctx.message ? String(ctx.message.text ?? "").trim() : "";
  if (text.startsWith("/")) return;

  const step = ctx.session?.step ?? null;
  if (step === "new") {
    const { amount, currency } = parseAmountCurrency(text);
    if (!amount || !currency) {
      await ctx.reply("格式不正确，请输入例如：30 CNY 或 100 USDT");
      return;
    }
    const order = {
      id: newOrderId(),
      amount,
      currency,
      status: "waiting_bind",
      createdAt: nowMs(),
      buyer: null,
      seller: null,
      bindTokens: {
        buyer: newBindToken(),
        seller: newBindToken()
      },
      pendingMessages: [],
      finalized: false
    };
    store.orders[order.id] = order;
    await saveStore(store);
    ctx.session = null;

    const buyerCode = `buyer:${order.id}:${order.bindTokens.buyer}`;
    const sellerCode = `seller:${order.id}:${order.bindTokens.seller}`;
    await ctx.reply(
      [
        "订单已创建。",
        "",
        "把对应绑定码发给买家/卖家去 /bind：",
        `买家绑定码：${buyerCode}`,
        `卖家绑定码：${sellerCode}`,
        "",
        "双方都绑定后，直接在私聊里发消息即可自动转发。"
      ].join("\n")
    );
    await notifyAdmins(order, "新订单创建");
    return;
  }

  if (step === "bind") {
    await handleBindCode(ctx, text);
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) return;
  const currentOrderId = activeOrderIdForUser(userId);
  if (!currentOrderId) return;
  const order = getOrder(currentOrderId);
  if (!order) return;

  const role = order.buyer?.id === userId ? "buyer" : order.seller?.id === userId ? "seller" : null;
  if (!role) return;
  if (!canChat(order)) return;

  const other = role === "buyer" ? order.seller : order.buyer;
  if (!other?.id) {
    order.pendingMessages.push({
      toUserId: null,
      toRole: otherRole(role),
      fromUserId: userId,
      messageId: ctx.message.message_id,
      ts: nowMs()
    });
    await saveStore(store);
    await ctx.reply("对方目前没有绑定交易，消息已保存，等对方绑定后会自动转发。");
    return;
  }

  try {
    await bot.telegram.copyMessage(other.id, userId, ctx.message.message_id);
  } catch {
    await ctx.reply("转发失败：对方可能未 /start 机器人或已屏蔽机器人。");
    return;
  }

  return;
});

function parseAmountCurrency(raw) {
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]{2,10})$/);
  if (!m) return { amount: null, currency: null };
  return { amount: m[1], currency: m[2].toUpperCase() };
}

async function handleBindCode(ctx, codeRaw) {
  const m = String(codeRaw).trim().match(/^(buyer|seller):([a-f0-9]{16,64}):([a-f0-9]{16,64})$/i);
  if (!m) {
    await ctx.reply("绑定码格式不正确。");
    return;
  }
  const role = m[1].toLowerCase();
  const orderId = m[2];
  const token = m[3];
  const order = getOrder(orderId);
  if (!order) {
    await ctx.reply("订单不存在。");
    return;
  }
  if (order.status === "completed" || order.status === "cancelled") {
    await ctx.reply("订单已结束，无法绑定。");
    return;
  }

  const expected = order.bindTokens?.[role];
  if (!expected || expected !== token) {
    await ctx.reply("绑定码无效或已使用。");
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) return;

  if (role === "buyer") {
    if (order.buyer?.id && order.buyer.id !== userId) {
      await ctx.reply("该订单买家已绑定。");
      return;
    }
    order.buyer = { id: userId, name: ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? "buyer") };
  } else {
    if (order.seller?.id && order.seller.id !== userId) {
      await ctx.reply("该订单卖家已绑定。");
      return;
    }
    order.seller = { id: userId, name: ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? "seller") };
  }

  order.bindTokens[role] = null;
  await setActiveOrderForUser(userId, order.id);

  if (order.buyer?.id && order.seller?.id) {
    order.status = "waiting_payment";
    await saveStore(store);

    await ctx.reply("绑定成功，订单已激活。直接在这里发消息会自动转发给对方。");
    await sendOrUpdateOrder(ctx, order);

    await flushPendingMessagesForBothSides(order);
    await notifyOtherSideBound(order, userId);
    return;
  }

  order.status = "waiting_bind";
  await saveStore(store);
  await ctx.reply("绑定成功，等待对方绑定后自动开始转发。");
  await sendOrUpdateOrder(ctx, order);
}

async function flushPendingMessagesForBothSides(order) {
  if (order.buyer?.id) await flushPendingMessages(order, order.buyer.id, "buyer");
  if (order.seller?.id) await flushPendingMessages(order, order.seller.id, "seller");
  await saveStore(store);
}

async function notifyOtherSideBound(order, boundUserId) {
  const otherId = order.buyer?.id === boundUserId ? order.seller?.id : order.buyer?.id;
  if (!otherId) return;
  try {
    await bot.telegram.sendMessage(otherId, "对方已绑定订单，可以开始聊天。");
    await bot.telegram.sendMessage(otherId, buildOrderText(order), buildOrderKeyboard(order, otherId));
  } catch {}
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

await bot.launch({ dropPendingUpdates: true });
process.stdout.write("escrow-bot started\n");
