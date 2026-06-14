import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

let ensuredCardKeys: Promise<void> | null = null;

export function ensureCardKeysTable(): Promise<void> {
  if (ensuredCardKeys) return ensuredCardKeys;
  ensuredCardKeys = (async () => {
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS "card_keys" (
        "id" serial PRIMARY KEY,
        "key" text NOT NULL,
        "type" text NOT NULL,
        "user_id" integer,
        "expires_at" timestamp,
        "activated_at" timestamp,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "note" text
      )
    `));
    await db.execute(sql.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS "card_keys_key_unique_idx"
      ON "card_keys" ("key")
    `));
    await db.execute(sql.raw(`ALTER TABLE "card_keys" ADD COLUMN IF NOT EXISTS "user_id" integer`));
    await db.execute(sql.raw(`ALTER TABLE "card_keys" ADD COLUMN IF NOT EXISTS "expires_at" timestamp`));
    await db.execute(sql.raw(`ALTER TABLE "card_keys" ADD COLUMN IF NOT EXISTS "activated_at" timestamp`));
    await db.execute(sql.raw(`ALTER TABLE "card_keys" ADD COLUMN IF NOT EXISTS "created_at" timestamp NOT NULL DEFAULT now()`));
    await db.execute(sql.raw(`ALTER TABLE "card_keys" ADD COLUMN IF NOT EXISTS "note" text`));
  })().catch(err => {
    ensuredCardKeys = null;
    throw err;
  });
  return ensuredCardKeys;
}
