import type { Request, Response, NextFunction } from "express";
import { verifyToken, COOKIE_NAME, type JwtPayload, ADMIN_SECRET_COOKIE, verifyAdminSecretToken } from "../lib/auth";
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

/** 后台二级密码验证：在 requireAdmin 基础上额外校验 admin_secret cookie */
export function requireAdminSecret(req: Request, res: Response, next: NextFunction): void {
  requireAdmin(req, res, () => {
    const token = (req.cookies as Record<string, string>)?.[ADMIN_SECRET_COOKIE];
    if (!token) {
      res.status(401).json({ error: "需要后台密码验证", code: "ADMIN_SECRET_REQUIRED" }); return;
    }
    const payload = verifyAdminSecretToken(token);
    if (!payload || payload.userId !== req.user!.userId) {
      res.status(401).json({ error: "后台密码已过期，请重新验证", code: "ADMIN_SECRET_EXPIRED" }); return;
    }
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
