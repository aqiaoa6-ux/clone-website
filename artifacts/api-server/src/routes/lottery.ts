import { Router } from "express";

const lotteryRouter = Router();

lotteryRouter.get("/lottery/fengpan", async (req, res) => {
  try {
    const response = await fetch("http://pc20.net/api/fengpan", {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        "Referer": "http://pc20.net/",
      },
    });

    if (!response.ok) {
      res.status(502).json({ error: "Upstream error", status: response.status });
      return;
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    req.log.error(err, "Failed to fetch lottery data");
    res.status(500).json({ error: "Failed to fetch lottery data" });
  }
});

export default lotteryRouter;
