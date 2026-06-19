import { pgTable, serial, text, integer, timestamp, boolean, bigint, uniqueIndex, index } from "drizzle-orm/pg-core";

export const canadaAiDraws = pgTable(
  "canada_ai_draws",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    sourceMsgId: bigint("source_msg_id", { mode: "number" }).notNull(),
    term: bigint("term", { mode: "number" }),
    digitA: integer("digit_a").notNull(),
    digitB: integer("digit_b").notNull(),
    digitC: integer("digit_c").notNull(),
    sum: integer("sum").notNull(),
    payloadJson: text("payload_json"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    sourceMsgUnique: uniqueIndex("canada_ai_draws_source_msg_uidx").on(table.source, table.sourceMsgId),
    sourceTermIdx: index("canada_ai_draws_source_term_idx").on(table.source, table.term),
  }),
);

export const canadaAiTrainingJobs = pgTable(
  "canada_ai_training_jobs",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    trigger: text("trigger").notNull(),
    modelKind: text("model_kind").notNull().default("true_sequence_v1"),
    status: text("status").notNull().default("queued"),
    historySize: integer("history_size").notNull().default(0),
    lookback: integer("lookback").notNull().default(96),
    metricsJson: text("metrics_json"),
    errorText: text("error_text"),
    modelVersionId: integer("model_version_id"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => ({
    statusIdx: index("canada_ai_training_jobs_status_idx").on(table.status, table.startedAt),
  }),
);

export const canadaAiModelVersions = pgTable(
  "canada_ai_model_versions",
  {
    id: serial("id").primaryKey(),
    version: text("version").notNull().unique(),
    source: text("source").notNull(),
    modelKind: text("model_kind").notNull().default("true_sequence_v1"),
    status: text("status").notNull().default("training"),
    historySize: integer("history_size").notNull().default(0),
    lookback: integer("lookback").notNull().default(96),
    metricsJson: text("metrics_json"),
    artifactPath: text("artifact_path"),
    isActive: boolean("is_active").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    trainedAt: timestamp("trained_at"),
    activatedAt: timestamp("activated_at"),
  },
  (table) => ({
    activeIdx: index("canada_ai_model_versions_active_idx").on(table.isActive, table.createdAt),
  }),
);

export type CanadaAiDraw = typeof canadaAiDraws.$inferSelect;
export type CanadaAiTrainingJob = typeof canadaAiTrainingJobs.$inferSelect;
export type CanadaAiModelVersion = typeof canadaAiModelVersions.$inferSelect;
