import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { lotteryService } from "../lib/lottery"; // 修改为你实际路径

const router = Router();

// 示例 GET 接口
router.get("/lottery", (req: Request, res: Response) => {
  try {
    const result = lotteryService.getResult(); // 根据你的逻辑
    res.status(200).json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// 如果你有 POST 或其他接口也用 Request/Response
router.post("/lottery/draw", (req: Request, res: Response) => {
  try {
    const body = req.body;
    const result = lotteryService.draw(body);
    res.status(200).json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
