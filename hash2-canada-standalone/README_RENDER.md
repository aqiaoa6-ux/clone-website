## Render 部署

这个目录是独立项目根目录：

`hash2-canada-standalone`

在 Render 里继续使用当前这个 Git 仓库时，建议这样配置：

- `Root Directory`：`hash2-canada-standalone`
- `Environment`：`Node`
- `Build Command`：`corepack enable && pnpm run render:build`
- `Start Command`：`pnpm run render:start`

必须配置的环境变量：

- `DATABASE_URL`
- `SESSION_SECRET`
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `PORT`

建议额外配置：

- `NODE_ENV=production`
- `DATA_DIR=/var/data`

说明：

- `DATABASE_URL` 必须换成一套新的独立数据库，不能再复用原项目数据库
- 构建时会自动执行 `drizzle push`，把表结构建到新数据库里
- 新数据库初始化后，`第一个注册用户会自动成为管理员`
- 前端会先构建到 `artifacts/lottery-bot/dist/public`
- 后端启动后会自动托管前端静态文件
- 当前新项目已经包含：
  - `账号系统`
  - `卡密系统`
  - `后台管理`
  - `TG整套`
  - `哈希2`
  - `加拿大`

当前 `加拿大` 模块已经接入前后端入口，但开奖源、下注时间、结算节奏仍是复制骨架，后续继续按加拿大规则调整。
