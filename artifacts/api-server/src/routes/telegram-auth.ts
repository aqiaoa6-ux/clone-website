import { Router } from "express";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";

const router = Router();

const API_ID = parseInt(process.env["TELEGRAM_API_ID"] ?? "0", 10);
const API_HASH = process.env["TELEGRAM_API_HASH"] ?? "";

interface PendingSession {
  client: TelegramClient;
  phoneCodeHash: string;
  phone: string;
  session: StringSession;
}

const pendingSessions = new Map<string, PendingSession>();
const activeSessions = new Map<string, { client: TelegramClient; session: string; me: object }>();

function getSessionKey(phone: string) {
  return phone.replace(/\D/g, "");
}

router.post("/telegram/request-code", async (req, res) => {
  const { phone } = req.body as { phone?: string };

  if (!phone) {
    res.status(400).json({ error: "phone required" });
    return;
  }
  if (!API_ID || !API_HASH) {
    res.status(500).json({ error: "Telegram API credentials not configured" });
    return;
  }

  const key = getSessionKey(phone);

  try {
    const session = new StringSession("");
    const client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 3,
    });

    await client.connect();

    const result = await client.sendCode(
      { apiId: API_ID, apiHash: API_HASH },
      phone,
    );

    pendingSessions.set(key, {
      client,
      phoneCodeHash: result.phoneCodeHash,
      phone,
      session,
    });

    req.log.info({ phone }, "Telegram code sent");
    res.json({ ok: true, phoneCodeHash: result.phoneCodeHash });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, phone }, "Failed to send Telegram code");
    res.status(500).json({ error: message });
  }
});

router.post("/telegram/verify-code", async (req, res) => {
  const { phone, code, phoneCodeHash } = req.body as {
    phone?: string;
    code?: string;
    phoneCodeHash?: string;
  };

  if (!phone || !code || !phoneCodeHash) {
    res.status(400).json({ error: "phone, code and phoneCodeHash required" });
    return;
  }

  const key = getSessionKey(phone);
  const pending = pendingSessions.get(key);

  if (!pending) {
    res.status(400).json({ error: "No pending session for this phone. Request a code first." });
    return;
  }

  try {
    await pending.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      }),
    );

    const me = await pending.client.getMe();
    const sessionStr = pending.session.save() as unknown as string;

    activeSessions.set(key, {
      client: pending.client,
      session: sessionStr,
      me: me as object,
    });
    pendingSessions.delete(key);

    req.log.info({ phone }, "Telegram login success");
    res.json({ ok: true, me, session: sessionStr });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("SESSION_PASSWORD_NEEDED") || message.includes("password")) {
      res.status(202).json({ ok: false, needPassword: true });
      return;
    }
    if (message.includes("PHONE_CODE_INVALID") || message.includes("CODE_INVALID")) {
      res.status(400).json({ error: "验证码错误，请重新输入" });
      return;
    }
    if (message.includes("PHONE_CODE_EXPIRED")) {
      res.status(400).json({ error: "验证码已过期，请重新获取" });
      return;
    }

    req.log.error({ err, phone }, "Failed to verify Telegram code");
    res.status(500).json({ error: message });
  }
});

router.post("/telegram/verify-password", async (req, res) => {
  const { phone, password } = req.body as { phone?: string; password?: string };

  if (!phone || !password) {
    res.status(400).json({ error: "phone and password required" });
    return;
  }

  const key = getSessionKey(phone);
  const pending = pendingSessions.get(key);

  if (!pending) {
    res.status(400).json({ error: "No pending session found" });
    return;
  }

  try {
    await pending.client.signInWithPassword(
      { apiId: API_ID, apiHash: API_HASH },
      {
        password: async () => password,
        onError: async (err: Error) => { throw err; },
      },
    );

    const me = await pending.client.getMe();
    const sessionStr = pending.session.save() as unknown as string;

    activeSessions.set(key, {
      client: pending.client,
      session: sessionStr,
      me: me as object,
    });
    pendingSessions.delete(key);

    req.log.info({ phone }, "Telegram 2FA login success");
    res.json({ ok: true, me, session: sessionStr });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("PASSWORD_HASH_INVALID") || message.includes("wrong password")) {
      res.status(400).json({ error: "二步验证密码错误" });
      return;
    }

    req.log.error({ err, phone }, "Failed to verify 2FA password");
    res.status(500).json({ error: message });
  }
});

router.post("/telegram/logout", async (req, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ error: "phone required" }); return; }

  const key = getSessionKey(phone);
  const active = activeSessions.get(key);
  if (active) {
    try { await active.client.invoke(new Api.auth.LogOut({})); } catch { /* ignore */ }
    activeSessions.delete(key);
  }
  pendingSessions.delete(key);

  res.json({ ok: true });
});

export default router;
