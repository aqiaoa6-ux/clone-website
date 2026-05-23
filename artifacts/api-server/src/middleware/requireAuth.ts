import type { Request, Response, NextFunction } from "express";
import { verifyToken, COOKIE_NAME, type JwtPayload } from "../lib/auth";
import { db } from "@workspace/db";
import { cardKeys } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = (req.cookies as Record<string, string>)?.[COOKIE_NAME];
  if (!token) { res.status(401).json({ error: "未登录", code: "UNAUTHENTICATED" }); return; }
  const payload = verifyToken(token);
  if (!payload) { res.status(401).json({ error: "登录已过期，请重新登录", code: "TOKEN_EXPIRED" }); return; }
  req.user = payload;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (!req.user?.isAdmin) { res.status(403).json({ error: "需要管理员权限" }); return; }
    next();
  });
}

export async function requireCard(req: Request, res: Response, next: NextFunction): Promise<void> {
  requireAuth(req, res, async () => {
    try {
      const now = new Date();
      const [card] = await db.select({ id: cardKeys.id, expiresAt: cardKeys.expiresAt })
        .from(cardKeys)
        .where(and(eq(cardKeys.userId, req.user!.userId), gt(cardKeys.expiresAt, now)))
        .limit(1);
      if (!card) {
        res.status(403).json({ error: "卡密未激活或已过期，请激活后使用", code: "CARD_REQUIRED" });
        return;
      }
      next();
    } catch {
      res.status(500).json({ error: "服务器错误" });
    }
  });
}
