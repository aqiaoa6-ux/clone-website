import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { count, desc, eq } from "drizzle-orm";
import {
  canadaAiDraws,
  canadaAiModelVersions,
  canadaAiTrainingJobs,
  db,
} from "@workspace/db";
import type { CanadaAiAxis, CanadaAiAttr, CanadaAiChannelHistoryEntry, CanadaAiDigits, CanadaAiFamily, CanadaAiSignal, CanadaAiTag } from "./canadaAi";

export const TRUE_AI_MODEL_KIND = "true_sequence_v1";
export const TRUE_AI_LOOKBACK = 96;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TRUE_AI_MODEL_PATH = path.resolve(MODULE_DIR, "..", "..", "model-data", "canada-true-ai-model.json");
const DEFAULT_CHANNEL_HISTORY_PATH = path.resolve(MODULE_DIR, "..", "..", "model-data", "canada-ai-channel-history.json");
const TRUE_AI_CONTEXT_SPANS = [2, 4, 6, 8] as const;
const TRUE_AI_MIN_HISTORY = 120;
export const TRUE_AI_PROD_MIN_HISTORY = 3000;
export const TRUE_AI_PROD_MIN_HEAD_COUNT = 8;
export const TRUE_AI_PROD_MIN_AVG_ACCURACY = 0.58;
export const TRUE_AI_PROD_MIN_HEAD_ACCURACY = 0.52;

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

export interface CanadaTrueAiAdminStatus {
  drawCount: number;
  readiness: CanadaTrueAiReadiness;
  latestJob: {
    id: number;
    status: string;
    source: string;
    trigger: string;
    historySize: number;
    startedAt: number | null;
    finishedAt: number | null;
    errorText: string | null;
  } | null;
  activeModel: {
    id: number;
    version: string;
    status: string;
    historySize: number;
    lookback: number;
    artifactPath: string | null;
    trainedAt: number | null;
    activatedAt: number | null;
    fileExists: boolean;
    headCount: number;
    accuracyAvg: number | null;
    accuracyMin: number | null;
    metrics: Record<string, unknown> | null;
  } | null;
}

export interface CanadaTrueAiReadiness {
  ready: boolean;
  score: number;
  reason: string | null;
  requiredHistorySize: number;
  requiredHeadCount: number;
  requiredAccuracyAvg: number;
  requiredAccuracyMin: number;
  historySize: number;
  headCount: number;
  accuracyAvg: number | null;
  accuracyMin: number | null;
  modelFileExists: boolean;
}

export interface CanadaTrueAiRuntimeStatus {
  modelPath: string;
  historySize: number;
  headCount: number;
  accuracyAvg: number | null;
  accuracyMin: number | null;
  modelFileExists: boolean;
  readiness: CanadaTrueAiReadiness;
}

interface CanadaTrueAiHeadModel {
  axis: CanadaAiAxis;
  family: CanadaAiFamily;
  attrs: CanadaAiAttr[];
  accuracy: number;
  sampleCount: number;
  globalCounts: Record<string, number>;
  contextCounts: Record<string, Record<string, Record<string, number>>>;
}

interface CanadaTrueAiModelBundle {
  version: number;
  modelKind: string;
  trainedAt: number;
  historySize: number;
  contextSpans: number[];
  heads: CanadaTrueAiHeadModel[];
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function numericMetric(metrics: Record<string, unknown> | null, key: string): number | null {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function averageHeadAccuracy(heads: CanadaTrueAiHeadModel[]): number | null {
  if (heads.length === 0) return null;
  return heads.reduce((sum, head) => sum + head.accuracy, 0) / heads.length;
}

function minimumHeadAccuracy(heads: CanadaTrueAiHeadModel[]): number | null {
  if (heads.length === 0) return null;
  return heads.reduce((min, head) => Math.min(min, head.accuracy), heads[0]!.accuracy);
}

function buildTrueAiReadiness(summary: {
  historySize: number;
  headCount: number;
  accuracyAvg: number | null;
  accuracyMin: number | null;
  modelFileExists: boolean;
}): CanadaTrueAiReadiness {
  const reasons: string[] = [];
  if (!summary.modelFileExists) reasons.push("模型文件不存在");
  if (summary.historySize < TRUE_AI_PROD_MIN_HISTORY) reasons.push(`历史样本少于${TRUE_AI_PROD_MIN_HISTORY}`);
  if (summary.headCount < TRUE_AI_PROD_MIN_HEAD_COUNT) reasons.push(`预测头少于${TRUE_AI_PROD_MIN_HEAD_COUNT}`);
  if (summary.accuracyAvg === null || summary.accuracyAvg < TRUE_AI_PROD_MIN_AVG_ACCURACY) {
    reasons.push(`平均准确率低于${Math.round(TRUE_AI_PROD_MIN_AVG_ACCURACY * 100)}%`);
  }
  if (summary.accuracyMin === null || summary.accuracyMin < TRUE_AI_PROD_MIN_HEAD_ACCURACY) {
    reasons.push(`最弱头准确率低于${Math.round(TRUE_AI_PROD_MIN_HEAD_ACCURACY * 100)}%`);
  }

  const historyRatio = clamp(summary.historySize / TRUE_AI_PROD_MIN_HISTORY, 0, 1);
  const headRatio = clamp(summary.headCount / TRUE_AI_PROD_MIN_HEAD_COUNT, 0, 1);
  const avgRatio = clamp((summary.accuracyAvg ?? 0) / TRUE_AI_PROD_MIN_AVG_ACCURACY, 0, 1);
  const minRatio = clamp((summary.accuracyMin ?? 0) / TRUE_AI_PROD_MIN_HEAD_ACCURACY, 0, 1);
  const fileRatio = summary.modelFileExists ? 1 : 0;
  const score = Math.round((historyRatio * 0.34 + headRatio * 0.18 + avgRatio * 0.28 + minRatio * 0.16 + fileRatio * 0.04) * 100);

  return {
    ready: reasons.length === 0,
    score,
    reason: reasons[0] ?? null,
    requiredHistorySize: TRUE_AI_PROD_MIN_HISTORY,
    requiredHeadCount: TRUE_AI_PROD_MIN_HEAD_COUNT,
    requiredAccuracyAvg: TRUE_AI_PROD_MIN_AVG_ACCURACY,
    requiredAccuracyMin: TRUE_AI_PROD_MIN_HEAD_ACCURACY,
    historySize: summary.historySize,
    headCount: summary.headCount,
    accuracyAvg: summary.accuracyAvg,
    accuracyMin: summary.accuracyMin,
    modelFileExists: summary.modelFileExists,
  };
}

function buildTrueAiModelSummary(
  bundle: CanadaTrueAiModelBundle | null,
  metrics: Record<string, unknown> | null,
  artifactPath: string | null,
): {
  historySize: number;
  headCount: number;
  accuracyAvg: number | null;
  accuracyMin: number | null;
  modelFileExists: boolean;
} {
  const modelPath = artifactPath ?? DEFAULT_TRUE_AI_MODEL_PATH;
  return {
    historySize: bundle?.historySize ?? numericMetric(metrics, "trueAiHistorySize") ?? numericMetric(metrics, "historySize") ?? 0,
    headCount: bundle?.heads.length ?? numericMetric(metrics, "trueAiHeadCount") ?? 0,
    accuracyAvg: bundle ? averageHeadAccuracy(bundle.heads) : numericMetric(metrics, "trueAiAccuracyAvg"),
    accuracyMin: bundle ? minimumHeadAccuracy(bundle.heads) : numericMetric(metrics, "trueAiAccuracyMin"),
    modelFileExists: !!modelPath && fs.existsSync(modelPath),
  };
}

function loadLocalChannelHistoryEntries(filePath = DEFAULT_CHANNEL_HISTORY_PATH): CanadaAiChannelHistoryEntry[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as CanadaAiChannelHistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) =>
      Number.isInteger(item?.msgId)
      && item.msgId > 0
      && Array.isArray(item.digits)
      && item.digits.length === 3
      && item.digits.every((value) => Number.isInteger(value) && value >= 0 && value <= 9),
    );
  } catch {
    return [];
  }
}

function axisValue(digits: CanadaAiDigits, axis: CanadaAiAxis): number {
  if (axis === "S") return digits[0] + digits[1] + digits[2];
  return digits[axis === "A" ? 0 : axis === "B" ? 1 : 2]!;
}

function attrFromDigits(axis: CanadaAiAxis, family: CanadaAiFamily, digits: CanadaAiDigits): CanadaAiAttr {
  const value = axisValue(digits, axis);
  if (family === "size") return axis === "S" ? (value >= 14 ? "大" : "小") : (value >= 5 ? "大" : "小");
  return value % 2 === 1 ? "单" : "双";
}

function attrsForFamily(family: CanadaAiFamily): CanadaAiAttr[] {
  return family === "size" ? ["大", "小"] : ["单", "双"];
}

function drawToken(digits: CanadaAiDigits): string {
  const parts = (["A", "B", "C", "S"] as const).flatMap((axis) => {
    const size = attrFromDigits(axis, "size", digits);
    const parity = attrFromDigits(axis, "parity", digits);
    return [`${axis}${size}`, `${axis}${parity}`];
  });
  return parts.join("|");
}

function buildContextKey(tokens: string[], endIndex: number, span: number): string | null {
  if (endIndex < span) return null;
  return tokens.slice(endIndex - span, endIndex).join(">");
}

function oppositeAttr(attr: CanadaAiAttr, family: CanadaAiFamily): CanadaAiAttr {
  if (family === "size") return attr === "大" ? "小" : "大";
  return attr === "单" ? "双" : "单";
}

function buildTrueAiTag(target: CanadaAiAttr, last: CanadaAiAttr, prev: CanadaAiAttr | null, probability: number): CanadaAiTag {
  if (target !== last) return prev === target || probability < 0.61 ? "震荡" : "逆势";
  if (probability >= 0.68) return "顺势";
  return prev && prev !== last ? "震荡" : "顺势";
}

function scoreHeadAccuracy(
  digitHistory: CanadaAiDigits[],
  axis: CanadaAiAxis,
  family: CanadaAiFamily,
  contextCounts: Record<string, Record<string, Record<string, number>>>,
  globalCounts: Record<string, number>,
): number {
  const tokens = digitHistory.map(drawToken);
  const attrs = attrsForFamily(family);
  let total = 0;
  let wins = 0;
  const start = Math.max(12, Math.floor(digitHistory.length * 0.75));
  for (let i = start; i < digitHistory.length; i++) {
    const target = attrFromDigits(axis, family, digitHistory[i]!);
    let selected: CanadaAiAttr = attrs[0]!;
    let bestProb = -1;
    for (const attr of attrs) {
      let score = (globalCounts[attr] ?? 0) + 1;
      for (const span of TRUE_AI_CONTEXT_SPANS) {
        const context = buildContextKey(tokens, i, span);
        if (!context) continue;
        const attrCounts = contextCounts[String(span)]?.[context];
        if (!attrCounts) continue;
        score += (attrCounts[attr] ?? 0) * (1 + span / 4);
      }
      if (score > bestProb) {
        bestProb = score;
        selected = attr;
      }
    }
    total++;
    if (selected === target) wins++;
  }
  return total > 0 ? wins / total : 0.5;
}

function trainTrueAiHead(
  digitHistory: CanadaAiDigits[],
  axis: CanadaAiAxis,
  family: CanadaAiFamily,
): CanadaTrueAiHeadModel {
  const tokens = digitHistory.map(drawToken);
  const attrs = attrsForFamily(family);
  const globalCounts: Record<string, number> = Object.fromEntries(attrs.map(attr => [attr, 0]));
  const contextCounts: Record<string, Record<string, Record<string, number>>> = {};

  for (let i = 0; i < digitHistory.length; i++) {
    const attr = attrFromDigits(axis, family, digitHistory[i]!);
    globalCounts[attr] = (globalCounts[attr] ?? 0) + 1;
    for (const span of TRUE_AI_CONTEXT_SPANS) {
      const context = buildContextKey(tokens, i, span);
      if (!context) continue;
      contextCounts[String(span)] ??= {};
      contextCounts[String(span)]![context] ??= Object.fromEntries(attrs.map(item => [item, 0]));
      contextCounts[String(span)]![context]![attr] = (contextCounts[String(span)]![context]![attr] ?? 0) + 1;
    }
  }

  return {
    axis,
    family,
    attrs,
    accuracy: scoreHeadAccuracy(digitHistory, axis, family, contextCounts, globalCounts),
    sampleCount: digitHistory.length,
    globalCounts,
    contextCounts,
  };
}

export function trainCanadaTrueAiModel(digitHistory: CanadaAiDigits[]): CanadaTrueAiModelBundle | null {
  if (digitHistory.length < TRUE_AI_MIN_HISTORY) return null;
  const heads: CanadaTrueAiHeadModel[] = [];
  for (const axis of ["A", "B", "C", "S"] as const) {
    heads.push(trainTrueAiHead(digitHistory, axis, "size"));
    heads.push(trainTrueAiHead(digitHistory, axis, "parity"));
  }
  return {
    version: 1,
    modelKind: TRUE_AI_MODEL_KIND,
    trainedAt: Date.now(),
    historySize: digitHistory.length,
    contextSpans: [...TRUE_AI_CONTEXT_SPANS],
    heads,
  };
}

export function saveCanadaTrueAiModel(bundle: CanadaTrueAiModelBundle, filePath = DEFAULT_TRUE_AI_MODEL_PATH): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), "utf8");
}

export function loadCanadaTrueAiModel(filePath = DEFAULT_TRUE_AI_MODEL_PATH): CanadaTrueAiModelBundle | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as CanadaTrueAiModelBundle;
  } catch {
    return null;
  }
}

export function getCanadaTrueAiRuntimeStatus(filePath = DEFAULT_TRUE_AI_MODEL_PATH): CanadaTrueAiRuntimeStatus {
  const bundle = loadCanadaTrueAiModel(filePath);
  const summary = buildTrueAiModelSummary(bundle, null, filePath);
  return {
    modelPath: filePath,
    historySize: summary.historySize,
    headCount: summary.headCount,
    accuracyAvg: summary.accuracyAvg,
    accuracyMin: summary.accuracyMin,
    modelFileExists: summary.modelFileExists,
    readiness: buildTrueAiReadiness(summary),
  };
}

function predictFromTrueAiHead(head: CanadaTrueAiHeadModel, digitHistory: CanadaAiDigits[]): CanadaAiSignal {
  const tokens = digitHistory.map(drawToken);
  const last = attrFromDigits(head.axis, head.family, digitHistory[digitHistory.length - 1]!);
  const prev = digitHistory.length > 1 ? attrFromDigits(head.axis, head.family, digitHistory[digitHistory.length - 2]!) : null;
  const scores = new Map<CanadaAiAttr, number>();
  for (const attr of head.attrs) {
    let score = (head.globalCounts[attr] ?? 0) + 1;
    for (const span of TRUE_AI_CONTEXT_SPANS) {
      const context = buildContextKey(tokens, digitHistory.length, span);
      if (!context) continue;
      const counts = head.contextCounts[String(span)]?.[context];
      if (!counts) continue;
      score += (counts[attr] ?? 0) * (1 + span / 4);
    }
    scores.set(attr, score);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const targetAttr = ranked[0]?.[0] ?? head.attrs[0]!;
  const totalScore = ranked.reduce((sum, [, score]) => sum + score, 0);
  const probability = totalScore > 0 ? (ranked[0]?.[1] ?? 0) / totalScore : 0.5;
  const tag = buildTrueAiTag(targetAttr, last, prev, probability);
  const confidence = Math.round(clamp(50 + (probability - 0.5) * 65 + (head.accuracy - 0.5) * 25, 50, 91));
  const strength = clamp(probability * 10 + head.accuracy * 4, 1, 12);
  return {
    axis: head.axis,
    family: head.family,
    bet: `${head.axis}${targetAttr}`,
    tag,
    confidence,
    strength,
    probability,
    accuracy: head.accuracy,
  };
}

function buildAlternativeTrueAiSignal(signal: CanadaAiSignal): CanadaAiSignal {
  const attr = signal.bet.slice(1) as CanadaAiAttr;
  const opposite = oppositeAttr(attr, signal.family);
  const tag: CanadaAiTag = signal.tag === "顺势" ? "逆势" : signal.tag === "逆势" ? "顺势" : "震荡";
  return {
    ...signal,
    bet: `${signal.axis}${opposite}`,
    tag,
    confidence: Math.round(clamp(signal.confidence - 8, 42, 78)),
    strength: clamp(signal.strength - 1.2, 0.8, 11),
    probability: 1 - signal.probability,
  };
}

export function predictCanadaTrueAiAxisSignals(
  axis: CanadaAiAxis,
  digitHistory: CanadaAiDigits[],
  filePath = DEFAULT_TRUE_AI_MODEL_PATH,
): CanadaAiSignal[] {
  const bundle = loadCanadaTrueAiModel(filePath);
  if (!bundle || digitHistory.length < 8) return [];
  return bundle.heads
    .filter((head) => head.axis === axis)
    .map((head) => predictFromTrueAiHead(head, digitHistory))
    .flatMap((signal) => [signal, buildAlternativeTrueAiSignal(signal)]);
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

export async function getCanadaTrueAiAdminStatus(): Promise<CanadaTrueAiAdminStatus> {
  const [drawCountRow] = await db
    .select({ count: count() })
    .from(canadaAiDraws)
    .where(eq(canadaAiDraws.source, "tg-channel:pc28"));
  let drawCount = Number(drawCountRow?.count ?? 0);
  const localEntries = loadLocalChannelHistoryEntries();
  if (localEntries.length > 0 && drawCount < localEntries.length) {
    drawCount = Math.max(drawCount, localEntries.length);
  }

  const latestJobRows = await db
    .select()
    .from(canadaAiTrainingJobs)
    .orderBy(desc(canadaAiTrainingJobs.startedAt))
    .limit(1);

  const activeModel = await getCanadaTrueAiActiveModel();
  const latestJob = latestJobRows[0] ?? null;
  const activeMetrics = activeModel ? parseJsonObject(activeModel.metricsJson ?? null) : null;
  const runtimeBundle = loadCanadaTrueAiModel(activeModel?.artifactPath ?? DEFAULT_TRUE_AI_MODEL_PATH);
  const runtimeSummary = buildTrueAiModelSummary(runtimeBundle, activeMetrics, activeModel?.artifactPath ?? null);
  const readiness = buildTrueAiReadiness(runtimeSummary);

  return {
    drawCount,
    readiness,
    latestJob: latestJob
      ? {
          id: latestJob.id,
          status: latestJob.status,
          source: latestJob.source,
          trigger: latestJob.trigger,
          historySize: latestJob.historySize,
          startedAt: latestJob.startedAt ? latestJob.startedAt.getTime() : null,
          finishedAt: latestJob.finishedAt ? latestJob.finishedAt.getTime() : null,
          errorText: latestJob.errorText ?? null,
        }
      : null,
    activeModel: activeModel
      ? {
          id: activeModel.id,
          version: activeModel.version,
          status: activeModel.status,
          historySize: activeModel.historySize,
          lookback: activeModel.lookback,
          artifactPath: activeModel.artifactPath ?? null,
          trainedAt: activeModel.trainedAt ? activeModel.trainedAt.getTime() : null,
          activatedAt: activeModel.activatedAt ? activeModel.activatedAt.getTime() : null,
          fileExists: runtimeSummary.modelFileExists,
          headCount: runtimeSummary.headCount,
          accuracyAvg: runtimeSummary.accuracyAvg,
          accuracyMin: runtimeSummary.accuracyMin,
          metrics: activeMetrics,
        }
      : null,
  };
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
