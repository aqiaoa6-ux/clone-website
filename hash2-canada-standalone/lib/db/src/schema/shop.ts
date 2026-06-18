import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";

export const shopConfig = pgTable("shop_config", {
  id: serial("id").primaryKey(),
  kkpayId: text("kkpay_id").notNull().default(""),
  kkpaySecret: text("kkpay_secret").notNull().default(""),
  domain: text("domain").notNull().default(""),
  productName: text("product_name").notNull().default("土豆飞投-卡密"),
  priceDailyUsdt: text("price_daily_usdt").notNull().default("1"),
  priceWeeklyUsdt: text("price_weekly_usdt").notNull().default("5"),
  priceMonthlyUsdt: text("price_monthly_usdt").notNull().default("15"),
  enabled: boolean("enabled").notNull().default(false),
  botToken: text("bot_token").default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const shopOrders = pgTable("shop_orders", {
  id: serial("id").primaryKey(),
  orderId: text("order_id").notNull().unique(),
  userId: integer("user_id").notNull(),
  cardType: text("card_type").notNull(),
  amountUsdt: text("amount_usdt").notNull(),
  status: text("status").notNull().default("pending"),
  cardKeyId: integer("card_key_id"),
  payUrl: text("pay_url"),
  tgChatId: text("tg_chat_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  paidAt: timestamp("paid_at"),
});

export type ShopConfig = typeof shopConfig.$inferSelect;
export type ShopOrder = typeof shopOrders.$inferSelect;
