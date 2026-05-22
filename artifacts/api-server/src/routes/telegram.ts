import { Router } from "express";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";

const router = Router();

function getCredentials() {
  const apiId = parseInt(process.env["TELEGRAM_API_ID"] ?? "0", 10);
  const apiHash = process.env["TELEGRAM_API_HASH"] ?? "";
  return { apiId, apiHash };
}

interface TgSession {
  client: TelegramClient;
  stringSession: StringSession;
  phone: string;
  phoneCodeHash?: string;
  me?: Api.User;
  groups: GroupInfo[];
  watchGroupId?: string;
  autoBet: boolean;
  betAmount: number;
}

interface GroupInfo {
  id: string;
  title: string;
  type: string;
  membersCount?: number;
}

interface BetRecord {
  id: string;
  groupId: string;
  groupTitle: string;
  messageText: string;
  betContent: string;
  timestamp: number;
  status: "sent" | "failed";
}

let tgSession: TgSession | null = null;
const betLog: BetRecord[] = [];
let messageHandler: ((event: NewMessageEvent) => Promise<void>) | null = null;

async function fetchGroups(client: TelegramClient): Promise<GroupInfo[]> {
  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    return dialogs
      .filter((d) => d.isGroup || d.isChannel)
      .map((d) => ({
        id: String(d.id),
        title: d.title ?? "Unknown",
        type: d.isChannel ? "channel" : "group",
        membersCount: (d.entity as Api.Chat)?.participantsCount ?? undefined,
      }));
  } catch {
    return [];
  }
}

function parseBetFromMessage(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("大单")) return "大单";
  if (lower.includes("大双")) return "大双";
  if (lower.includes("小单")) return "小单";
  if (lower.includes("小双")) return "小双";
  if (lower.includes("大")) return "大";
  if (lower.includes("小")) return "小";
  if (lower.includes("单")) return "单";
  if (lower.includes("双")) return "双";
  return null;
}

function startWatching(session: TgSession) {
  if (!session.watchGroupId) return;

  if (messageHandler) {
    try { session.client.removeEventHandler(messageHandler, new NewMessage({})); } catch { /* ok */ }
  }

  const targetId = session.watchGroupId;

  messageHandler = async (event: NewMessageEvent) => {
    if (!session.autoBet) return;
    const msg = event.message;
    const chatId = String(msg.chatId);
    if (chatId !== targetId && `-100${chatId}` !== targetId) return;

    const text = msg.message ?? "";
    const bet = parseBetFromMessage(text);
    if (!bet) return;

    const group = session.groups.find(
      (g) => g.id === targetId || `-100${g.id}` === targetId,
    );

    try {
      await session.client.sendMessage(targetId, {
        message: `投注：${bet}  金额：${session.betAmount}`,
      });
      betLog.unshift({
        id: String(Date.now()),
        groupId: targetId,
        groupTitle: group?.title ?? targetId,
        messageText: text.slice(0, 80),
        betContent: bet,
        timestamp: Date.now(),
        status: "sent",
      });
      if (betLog.length > 200) betLog.pop();
    } catch {
      betLog.unshift({
        id: String(Date.now()),
        groupId: targetId,
        groupTitle: group?.title ?? targetId,
        messageText: text.slice(0, 80),
        betContent: bet,
        timestamp: Date.now(),
        status: "failed",
      });
    }
  };

  session.client.addEventHandler(messageHandler, new NewMessage({}));
}

// ─── Send verification code ───────────────────────────────────────────────────
router.post("/tg/send-code", async (req, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ error: "请输入手机号" }); return; }

  const { apiId, apiHash } = getCredentials();
  if (!apiId || !apiHash) {
    res.status(500).json({ error: "服务端未配置 Telegram API 凭证，请联系管理员" });
    return;
  }

  try {
    if (tgSession?.client?.connected) {
      try { await tgSession.client.disconnect(); } catch { /* ok */ }
    }

    const stringSession = new StringSession("");
    const client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 3,
      deviceModel: "iPhone 14",
      systemVersion: "iOS 17.0",
      appVersion: "9.7.0",
    });

    await client.connect();

    const result = await client.sendCode({ apiId, apiHash }, phone);

    tgSession = {
      client,
      stringSession,
      phone,
      phoneCodeHash: result.phoneCodeHash,
      groups: [],
      autoBet: false,
      betAmount: 100,
    };

    req.log.info({ phone }, "TG code sent");
    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, phone }, "send-code failed");
    if (msg.includes("PHONE_NUMBER_INVALID")) {
      res.status(400).json({ error: "手机号格式错误（需含国家码，如 +8613800001234）" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ─── Verify code ─────────────────────────────────────────────────────────────
router.post("/tg/verify-code", async (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ error: "请输入验证码" }); return; }
  if (!tgSession) { res.status(400).json({ error: "请先发送验证码" }); return; }

  const { apiId, apiHash } = getCredentials();

  try {
    const result = await tgSession.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: tgSession.phone,
        phoneCodeHash: tgSession.phoneCodeHash!,
        phoneCode: code,
      }),
    );

    const me = (result as Api.auth.Authorization).user as Api.User;
    tgSession.me = me;
    tgSession.groups = await fetchGroups(tgSession.client);

    req.log.info({ username: me.username }, "TG sign-in success");
    res.json({
      ok: true,
      me: { id: me.id, firstName: me.firstName, lastName: me.lastName, username: me.username, phone: me.phone },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SESSION_PASSWORD_NEEDED")) {
      res.json({ ok: false, needPassword: true });
      return;
    }
    if (msg.includes("PHONE_CODE_INVALID") || msg.includes("CODE_INVALID")) {
      res.status(400).json({ error: "验证码错误" });
      return;
    }
    if (msg.includes("PHONE_CODE_EXPIRED")) {
      res.status(400).json({ error: "验证码已过期，请重新获取" });
      return;
    }
    req.log.error({ err }, "verify-code failed");
    res.status(500).json({ error: msg });
  }
});

// ─── Verify 2FA password ──────────────────────────────────────────────────────
router.post("/tg/verify-password", async (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password) { res.status(400).json({ error: "请输入二步验证密码" }); return; }
  if (!tgSession) { res.status(400).json({ error: "会话已失效，请重新登录" }); return; }

  const { apiId, apiHash } = getCredentials();

  try {
    await tgSession.client.signInWithPassword(
      { apiId, apiHash },
      {
        password: async () => password,
        onError: async (err: Error) => { throw err; },
      },
    );

    const me = await tgSession.client.getMe() as Api.User;
    tgSession.me = me;
    tgSession.groups = await fetchGroups(tgSession.client);

    req.log.info({ username: me.username }, "TG 2FA success");
    res.json({
      ok: true,
      me: { id: me.id, firstName: me.firstName, lastName: me.lastName, username: me.username, phone: me.phone },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("PASSWORD_HASH_INVALID")) {
      res.status(400).json({ error: "二步验证密码错误" });
      return;
    }
    req.log.error({ err }, "verify-password failed");
    res.status(500).json({ error: msg });
  }
});

// ─── Status ───────────────────────────────────────────────────────────────────
router.get("/tg/status", (req, res) => {
  if (!tgSession?.me) { res.json({ connected: false }); return; }
  const me = tgSession.me;
  res.json({
    connected: true,
    me: { id: me.id, firstName: me.firstName, lastName: me.lastName, username: me.username, phone: me.phone },
    watchGroupId: tgSession.watchGroupId,
    autoBet: tgSession.autoBet,
    betAmount: tgSession.betAmount,
  });
});

// ─── Groups ───────────────────────────────────────────────────────────────────
router.get("/tg/groups", async (req, res) => {
  if (!tgSession?.client) { res.status(401).json({ error: "未登录" }); return; }
  tgSession.groups = await fetchGroups(tgSession.client);
  res.json({ groups: tgSession.groups });
});

// ─── Resolve group by link/username ──────────────────────────────────────────
router.post("/tg/resolve-group", async (req, res) => {
  if (!tgSession?.client) { res.status(401).json({ error: "未登录" }); return; }
  const { link } = req.body as { link?: string };
  if (!link) { res.status(400).json({ error: "请提供群链接" }); return; }

  let username = link.trim();
  username = username.replace(/^https?:\/\/t\.me\//i, "");
  username = username.replace(/^@/, "");
  username = username.replace(/\?.*$/, "");

  try {
    const entity = await tgSession.client.getEntity(username);
    const id = String((entity as unknown as { id: bigint | number }).id);
    const title = (entity as { title?: string; firstName?: string }).title
      ?? (entity as { firstName?: string }).firstName
      ?? username;
    const isChannel = "broadcast" in entity;
    const group: GroupInfo = { id, title, type: isChannel ? "channel" : "group" };
    res.json({ ok: true, group });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, username }, "resolve-group failed");
    if (msg.includes("USERNAME_NOT_OCCUPIED") || msg.includes("Cannot find")) {
      res.status(404).json({ error: "找不到该群，请检查链接是否正确" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ─── Set watch group ──────────────────────────────────────────────────────────
router.post("/tg/set-group", (req, res) => {
  const { groupId, autoBet, betAmount } = req.body as {
    groupId?: string;
    autoBet?: boolean;
    betAmount?: number;
  };
  if (!tgSession) { res.status(401).json({ error: "未登录" }); return; }

  if (groupId !== undefined) tgSession.watchGroupId = groupId;
  if (autoBet !== undefined) tgSession.autoBet = autoBet;
  if (betAmount !== undefined) tgSession.betAmount = betAmount;

  if (tgSession.watchGroupId) startWatching(tgSession);

  res.json({ ok: true });
});

// ─── Bet log ──────────────────────────────────────────────────────────────────
router.get("/tg/bets", (_req, res) => {
  res.json({ bets: betLog.slice(0, 50) });
});

// ─── Disconnect ───────────────────────────────────────────────────────────────
router.post("/tg/disconnect", async (_req, res) => {
  if (tgSession?.client) {
    try { await tgSession.client.invoke(new Api.auth.LogOut()); } catch { /* ok */ }
    try { await tgSession.client.disconnect(); } catch { /* ok */ }
  }
  tgSession = null;
  messageHandler = null;
  res.json({ ok: true });
});

export default router;
