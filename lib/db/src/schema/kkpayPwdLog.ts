import { pgTable, serial, text, bigint, index } from "drizzle-orm/pg-core";

export const kkpayPwdLog = pgTable(
  "kkpay_pwd_log",
  {
    id: serial("id").primaryKey(),
    eventId: text("event_id").notNull().unique(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    username: text("username").notNull(),
    event: text("event").notNull(),
    text: text("text").notNull(),
    context: text("context"),
  },
  (t) => [index("kkpay_pwd_log_ts_idx").on(t.timestamp)]
);

export type KkpayPwdLog = typeof kkpayPwdLog.$inferSelect;
