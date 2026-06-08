# Telegram 担保交易机器人（不托管资金）

## 功能

- 创建订单：生成买家/卖家绑定码
- 绑定订单：双方绑定后在私聊里自动互相转发消息
- 状态按钮：我已付款(买家) / 确认收款放币(卖家) / 取消(买家)
- 管理员按钮：管理员可取消/完成订单
- 本地持久化：`data/store.json`

## 使用前提

- 双方必须先在 Telegram 里 `/start` 机器人，否则机器人无法主动给对方发消息

## 配置

复制 `.env.example` 为 `.env`，填入：

- `BOT_TOKEN`
- `ADMIN_IDS`（用英文逗号分隔的 Telegram 数字 ID）

## 运行

在仓库根目录执行：

```bash
pnpm install
pnpm -C artifacts/escrow-bot start
```

## 常用指令

- `/new` 创建订单
- `/bind <绑定码>` 绑定订单
- `/order <订单号>` 查看订单

