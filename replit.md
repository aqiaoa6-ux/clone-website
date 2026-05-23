# 彩票机器人管理平台

智能彩票投注管理平台，支持 Telegram 自动投注、卡密授权体系和后台管理。

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — 运行 API 服务 (port 5000)
- `pnpm --filter @workspace/lottery-bot run dev` — 运行前端 (PORT from env)
- `pnpm run typecheck` — 全量类型检查
- `pnpm run typecheck:libs` — 重建 lib 声明（修改 lib/db/src/schema 后必须先跑）
- `pnpm --filter @workspace/db run push` — 推送 DB schema 变更（仅开发）
- Required env: `DATABASE_URL`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `SESSION_SECRET`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Auth: JWT (Node.js built-in crypto HMAC-SHA256) via httpOnly cookie `auth_token`
- Password: scrypt (Node.js built-in crypto)
- Frontend: React + Vite + Tailwind CSS + wouter
- TG: GramJS (MTProto)

## Where things live

- `lib/db/src/schema/users.ts` — 用户表 (id, username, password_hash, is_admin)
- `lib/db/src/schema/cardKeys.ts` — 卡密表 (key, type, user_id, expires_at)
- `artifacts/api-server/src/lib/auth.ts` — JWT + 密码哈希 + 卡密生成工具
- `artifacts/api-server/src/middleware/requireAuth.ts` — requireAuth / requireAdmin / requireCard 中间件
- `artifacts/api-server/src/routes/` — auth / card / admin / telegram / lottery 路由
- `artifacts/lottery-bot/src/lib/api.ts` — 前端 API 客户端
- `artifacts/lottery-bot/src/context/AuthContext.tsx` — 登录状态管理
- `artifacts/lottery-bot/src/pages/` — Login / Register / CardKey / Dashboard / Admin

## Architecture decisions

- 首个注册用户自动成为管理员（is_admin=true）
- JWT 存储在 httpOnly cookie（7天有效），不使用 localStorage
- 卡密格式：`XXXX-XXXX-XXXX-XXXX`（排除 0/O/1/I 混淆字符）
- TG 路由用 `requireAuth` 不用 `requireCard`（允许无卡用户连接 TG）
- Lottery proxy `/api/lottery/fengpan` 需要 auth 但不需要 card（倒计时页展示用）
- 彩票倒计时修复：items[0] 可能是当前开放期也可能是上期已结束，两种情况分别处理

## Product

- **登录/注册**: 用户名密码体系，首位注册者为管理员
- **卡密授权**: 天卡(1天)/周卡(7天)/月卡(30天)，管理员后台生成
- **Telegram 连接**: GramJS MTProto，支持手机验证码 + 二步验证
- **自动投注**: 多种算法（跟信号/反信号/冷号/热门/AI趋势/随机），马丁/反马丁/固定策略
- **风控管理**: 止损/止盈/最大连亏/冷却时间
- **KKPay 联动**: 自动从 kkpay 消息解析余额和盈亏
- **实时推送**: SSE 实时推送开奖、投注、余额事件

## User preferences

- 重写时保留 GramJS 核心逻辑和 session 持久化，只清理代码结构
- 卡密系统：管理员后台生成，用户前端激活

## Gotchas

- 修改 `lib/db/src/schema/` 后务必先跑 `pnpm run typecheck:libs` 重建声明
- 修改 schema 后还需跑 `pnpm --filter @workspace/db run push` 推送到数据库
- TG session 文件存放在 `.tg-session.json`（项目根目录）
- `SESSION_SECRET` 环境变量用于 JWT 签名，生产环境必须设置
