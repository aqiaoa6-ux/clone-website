import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

router.get("/lottery/fengpan", requireAuth, async (req, res) => {
  try {
    const r = await fetch("http://pc20.net/api/fengpan", {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        "Referer": "http://pc20.net/",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      res.status(502).json({ error: `upstream_http_${r.status}` });
      return;
    }
    const data = await r.json() as unknown;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
