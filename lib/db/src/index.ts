import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,   // 拿不到连接 5s 内报错
  idleTimeoutMillis: 30_000,        // 空闲连接 30s 后释放
  max: 10,
});

// 每条新连接设置 10s statement_timeout，防止慢查询挂死
pool.on("connect", (client) => {
  client.query("SET statement_timeout = 10000").catch(() => {});
});

export const db = drizzle(pool, { schema });

export * from "./schema";
