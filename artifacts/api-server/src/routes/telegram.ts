import { Router } from "express";

const router = Router();

interface BotInfo {
  id: number;
  first_name: string;
  username: string;
  is_bot: boolean;
}

const activeTokens = new Map<string, BotInfo>();

router.post("/telegram/connect", async (req, res) => {
  const { token } = req.body as { token?: string };

  if (!token || !token.includes(":")) {
    res.status(400).json({ error: "请输入有效的 Bot Token（格式：123456:ABCdef...）" });
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await response.json()) as { ok: boolean; result?: BotInfo; description?: string };

    if (!data.ok || !data.result) {
      res.status(401).json({ error: data.description ?? "Token 无效，请检查后重试" });
      return;
    }

    activeTokens.set(token, data.result);
    req.log.info({ username: data.result.username }, "Telegram bot connected");
    res.json({ ok: true, bot: data.result });
  } catch (err) {
    req.log.error(err, "Failed to connect Telegram bot");
    res.status(500).json({ error: "连接失败，请检查网络后重试" });
  }
});

router.post("/telegram/disconnect", (req, res) => {
  const { token } = req.body as { token?: string };
  if (token) activeTokens.delete(token);
  res.json({ ok: true });
});

router.get("/telegram/status", (req, res) => {
  const { token } = req.query as { token?: string };
  if (!token || !activeTokens.has(token)) {
    res.json({ connected: false });
    return;
  }
  res.json({ connected: true, bot: activeTokens.get(token) });
});

export default router;
