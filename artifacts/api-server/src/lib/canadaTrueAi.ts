import { count, desc, eq } from "drizzle-orm";
import {
  canadaAiDraws,
  canadaAiModelVersions,
  canadaAiTrainingJobs,
  db,
} from "@workspace/db";
import type { CanadaAiChannelHistoryEntry, CanadaAiDigits } from "./canadaAi";

export const TRUE_AI_MODEL_KIND = "true_sequence_v1";
export const TRUE_AI_LOOKBACK = 96;

export interface CanadaTrueAiSequenceSample {
  history: CanadaAiDigits[];
  target: CanadaAiDigits;
  targetSum: number;
  targetSize: "大" | "小";
  targetParity: "单" | "双";
}

export interface CanadaTrueAiDatasetSummary {
  sampleCount: number;
  lookback: number;
  historySize: number;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export async function syncCanadaTrueAiDraws(
  entries: CanadaAiChannelHistoryEntry[],
  source: string,
): Promise<{ insertedEstimate: number; total: number }> {
  if (entries.length === 0) {
    const existing = await db
      .select({ count: count() })
      .from(canadaAiDraws)
      .where(eq(canadaAiDraws.source, source));
    return { insertedEstimate: 0, total: Number(existing[0]?.count ?? 0) };
  }

  const rows = entries.map((item) => ({
    source,
    sourceMsgId: item.msgId,
    term: item.term,
    digitA: item.digits[0],
    digitB: item.digits[1],
    digitC: item.digits[2],
    sum: item.digits[0] + item.digits[1] + item.digits[2],
    payloadJson: safeJson(item),
  }));

  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insert(canadaAiDraws)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing();
  }

  const totalRows = await db
    .select({ count: count() })
    .from(canadaAiDraws)
    .where(eq(canadaAiDraws.source, source));

  return { insertedEstimate: rows.length, total: Number(totalRows[0]?.count ?? 0) };
}

export async function createCanadaTrueAiTrainingJob(args: {
  source: string;
  trigger: string;
  historySize: number;
  lookback?: number;
}): Promise<number> {
  const inserted = await db
    .insert(canadaAiTrainingJobs)
    .values({
      source: args.source,
      trigger: args.trigger,
      modelKind: TRUE_AI_MODEL_KIND,
      status: "running",
      historySize: args.historySize,
      lookback: args.lookback ?? TRUE_AI_LOOKBACK,
    })
    .returning({ id: canadaAiTrainingJobs.id });
  return inserted[0]!.id;
}

export async function completeCanadaTrueAiTrainingJob(args: {
  jobId: number;
  historySize: number;
  metrics: Record<string, unknown>;
  artifactPath: string;
  activate?: boolean;
}): Promise<number> {
  const version = `${TRUE_AI_MODEL_KIND}-${Date.now()}`;
  const inserted = await db
    .insert(canadaAiModelVersions)
    .values({
      version,
      source: "tg-channel:pc28",
      modelKind: TRUE_AI_MODEL_KIND,
      status: "ready",
      historySize: args.historySize,
      lookback: TRUE_AI_LOOKBACK,
      metricsJson: safeJson(args.metrics),
      artifactPath: args.artifactPath,
      isActive: !!args.activate,
      trainedAt: new Date(),
      activatedAt: args.activate ? new Date() : null,
    })
    .returning({ id: canadaAiModelVersions.id });

  if (args.activate) {
    await db
      .update(canadaAiModelVersions)
      .set({ isActive: false })
      .where(eq(canadaAiModelVersions.modelKind, TRUE_AI_MODEL_KIND));
    await db
      .update(canadaAiModelVersions)
      .set({ isActive: true, activatedAt: new Date() })
      .where(eq(canadaAiModelVersions.id, inserted[0]!.id));
  }

  await db
    .update(canadaAiTrainingJobs)
    .set({
      status: "completed",
      historySize: args.historySize,
      metricsJson: safeJson(args.metrics),
      modelVersionId: inserted[0]!.id,
      finishedAt: new Date(),
    })
    .where(eq(canadaAiTrainingJobs.id, args.jobId));

  return inserted[0]!.id;
}

export async function failCanadaTrueAiTrainingJob(jobId: number, errorText: string): Promise<void> {
  await db
    .update(canadaAiTrainingJobs)
    .set({
      status: "failed",
      errorText,
      finishedAt: new Date(),
    })
    .where(eq(canadaAiTrainingJobs.id, jobId));
}

export async function getCanadaTrueAiActiveModel() {
  const rows = await db
    .select()
    .from(canadaAiModelVersions)
    .where(eq(canadaAiModelVersions.isActive, true))
    .orderBy(desc(canadaAiModelVersions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export function buildCanadaTrueAiSequenceDataset(
  digitHistory: CanadaAiDigits[],
  lookback = TRUE_AI_LOOKBACK,
): { samples: CanadaTrueAiSequenceSample[]; summary: CanadaTrueAiDatasetSummary } {
  const samples: CanadaTrueAiSequenceSample[] = [];
  for (let i = lookback; i < digitHistory.length; i++) {
    const history = digitHistory.slice(i - lookback, i);
    const target = digitHistory[i]!;
    const targetSum = target[0] + target[1] + target[2];
    samples.push({
      history,
      target,
      targetSum,
      targetSize: targetSum >= 14 ? "大" : "小",
      targetParity: targetSum % 2 === 1 ? "单" : "双",
    });
  }
  return {
    samples,
    summary: {
      sampleCount: samples.length,
      lookback,
      historySize: digitHistory.length,
    },
  };
}
