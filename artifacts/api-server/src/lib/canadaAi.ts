import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

export type CanadaAiAxis = "A" | "B" | "C" | "S";
export type CanadaAiFamily = "size" | "parity";
export type CanadaAiAttr = "大" | "小" | "单" | "双";
export type CanadaAiTag = "顺势" | "逆势" | "震荡";
export type CanadaAiDigits = [number, number, number];

export interface CanadaAiSignal {
  axis: CanadaAiAxis;
  family: CanadaAiFamily;
  bet: string;
  tag: CanadaAiTag;
  confidence: number;
  strength: number;
  probability: number;
  accuracy: number;
}

interface CanadaAiFeature {
  labels: CanadaAiAttr[];
  shortRatio: number;
  midRatio: number;
  longRatio: number;
  tailPositive: number;
  tailNegative: number;
  altRatio: number;
  gapPositive: number;
  gapNegative: number;
  bouncePositive: number;
  bounceNegative: number;
}

interface CanadaAiBinaryModel {
  axis: CanadaAiAxis;
  family: CanadaAiFamily;
  positiveAttr: CanadaAiAttr;
  weights: number[];
  bias: number;
  accuracy: number;
  sampleCount: number;
}

interface CanadaAiModelBundle {
  version: number;
  trainedAt: number;
  historySize: number;
  models: CanadaAiBinaryModel[];
}

const MODEL_VERSION = 1;
const MIN_TRAIN_HISTORY = 72;
const FEATURE_START_INDEX = 24;
const TRAIN_EPOCHS = 240;
const REGULARIZATION = 0.0025;
const DEFAULT_MODEL_PATH = path.join(process.cwd(), "artifacts", "api-server", "model-data", "canada-ai-model.json");

let cachedBundle: CanadaAiModelBundle | null = null;
let cachedSignature = "";
let warmupPromise: Promise<CanadaAiModelBundle | null> | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function familyAttrs(family: CanadaAiFamily): [CanadaAiAttr, CanadaAiAttr] {
  return family === "size" ? ["大", "小"] : ["单", "双"];
}

function oppositeAttr(attr: CanadaAiAttr, family: CanadaAiFamily): CanadaAiAttr {
  if (family === "size") return attr === "大" ? "小" : "大";
  return attr === "单" ? "双" : "单";
}

function digitLabel(axis: CanadaAiAxis, family: CanadaAiFamily, value: number): CanadaAiAttr {
  if (family === "size") {
    if (axis === "S") return value >= 14 ? "大" : "小";
    return value >= 5 ? "大" : "小";
  }
  return value % 2 === 1 ? "单" : "双";
}

function historyValues(axis: CanadaAiAxis, digitHistory: CanadaAiDigits[]): number[] {
  return axis === "S"
    ? digitHistory.map(([a, b, c]) => a + b + c)
    : digitHistory.map(item => item[axis === "A" ? 0 : axis === "B" ? 1 : 2]!);
}

function historySignature(digitHistory: CanadaAiDigits[]): string {
  const tail = digitHistory.slice(-18).map(item => item.join(""));
  return `${digitHistory.length}:${tail.join("|")}`;
}

function buildFeature(axis: CanadaAiAxis, family: CanadaAiFamily, values: number[]): CanadaAiFeature {
  const labels = values.map(value => digitLabel(axis, family, value));
  const [positiveAttr, negativeAttr] = familyAttrs(family);
  const short = labels.slice(-8);
  const mid = labels.slice(-14);
  const long = labels.slice(-24);
  const ratio = (items: CanadaAiAttr[], attr: CanadaAiAttr) => items.length > 0
    ? items.filter(item => item === attr).length / items.length
    : 0;

  let tailPositive = 0;
  for (let i = labels.length - 1; i >= 0 && labels[i] === positiveAttr; i--) tailPositive++;

  let tailNegative = 0;
  for (let i = labels.length - 1; i >= 0 && labels[i] === negativeAttr; i--) tailNegative++;

  let alternations = 0;
  for (let i = 1; i < short.length; i++) {
    if (short[i] !== short[i - 1]) alternations++;
  }
  const altRatio = short.length > 1 ? alternations / (short.length - 1) : 0;

  const reverseGap = (attr: CanadaAiAttr) => {
    const idx = [...labels].reverse().findIndex(item => item === attr);
    return idx < 0 ? labels.length : idx;
  };
  const bounceRate = (from: CanadaAiAttr, to: CanadaAiAttr) => {
    let opportunities = 0;
    let hits = 0;
    for (let i = 1; i < short.length; i++) {
      if (short[i - 1] === from) {
        opportunities++;
        if (short[i] === to) hits++;
      }
    }
    return opportunities > 0 ? hits / opportunities : 0;
  };

  return {
    labels,
    shortRatio: ratio(short, positiveAttr),
    midRatio: ratio(mid, positiveAttr),
    longRatio: ratio(long, positiveAttr),
    tailPositive,
    tailNegative,
    altRatio,
    gapPositive: reverseGap(positiveAttr),
    gapNegative: reverseGap(negativeAttr),
    bouncePositive: bounceRate(negativeAttr, positiveAttr),
    bounceNegative: bounceRate(positiveAttr, negativeAttr),
  };
}

function featureVector(feature: CanadaAiFeature): number[] {
  const last = feature.labels[feature.labels.length - 1] ?? "大";
  const prev = feature.labels[feature.labels.length - 2] ?? null;
  const positiveLast = last === "大" || last === "单" ? 1 : 0;
  const positivePrev = prev === "大" || prev === "单" ? 1 : 0;
  return [
    1,
    positiveLast,
    positivePrev,
    feature.shortRatio,
    feature.midRatio,
    feature.longRatio,
    feature.shortRatio - feature.midRatio,
    feature.midRatio - feature.longRatio,
    feature.tailPositive / 6,
    feature.tailNegative / 6,
    feature.altRatio,
    Math.min(feature.gapPositive, 12) / 12,
    Math.min(feature.gapNegative, 12) / 12,
    feature.bouncePositive,
    feature.bounceNegative,
  ];
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-18, Math.min(18, value))));
}

function trainBinaryModel(axis: CanadaAiAxis, family: CanadaAiFamily, values: number[]): CanadaAiBinaryModel | null {
  if (values.length < MIN_TRAIN_HISTORY) return null;
  const [positiveAttr] = familyAttrs(family);
  const rows: number[][] = [];
  const labels: number[] = [];
  for (let i = FEATURE_START_INDEX; i < values.length; i++) {
    const feature = buildFeature(axis, family, values.slice(0, i));
    rows.push(featureVector(feature));
    labels.push(digitLabel(axis, family, values[i]!) === positiveAttr ? 1 : 0);
  }
  if (rows.length < 24) return null;

  const dim = rows[0]!.length;
  const weights = Array.from({ length: dim }, () => 0);
  let bias = 0;
  let lr = 0.28;
  const splitIndex = Math.max(18, Math.floor(rows.length * 0.82));
  const trainRows = rows.slice(0, splitIndex);
  const trainLabels = labels.slice(0, splitIndex);
  const testRows = rows.slice(splitIndex);
  const testLabels = labels.slice(splitIndex);

  for (let epoch = 0; epoch < TRAIN_EPOCHS; epoch++) {
    for (let i = 0; i < trainRows.length; i++) {
      const row = trainRows[i]!;
      const target = trainLabels[i]!;
      let z = bias;
      for (let j = 0; j < row.length; j++) z += weights[j]! * row[j]!;
      const prob = sigmoid(z);
      const err = prob - target;
      for (let j = 0; j < row.length; j++) {
        weights[j] = weights[j]! - lr * (err * row[j]! + REGULARIZATION * weights[j]!);
      }
      bias -= lr * err;
    }
    lr *= 0.992;
  }

  const evalRows = testRows.length > 0 ? testRows : rows;
  const evalLabels = testLabels.length > 0 ? testLabels : labels;
  let correct = 0;
  for (let i = 0; i < evalRows.length; i++) {
    const row = evalRows[i]!;
    let z = bias;
    for (let j = 0; j < row.length; j++) z += weights[j]! * row[j]!;
    const pred = sigmoid(z) >= 0.5 ? 1 : 0;
    if (pred === evalLabels[i]) correct++;
  }

  return {
    axis,
    family,
    positiveAttr,
    weights,
    bias,
    accuracy: evalRows.length > 0 ? correct / evalRows.length : 0.5,
    sampleCount: rows.length,
  };
}

export function trainCanadaAiModel(digitHistory: CanadaAiDigits[]): CanadaAiModelBundle | null {
  if (digitHistory.length < MIN_TRAIN_HISTORY) return null;
  const models: CanadaAiBinaryModel[] = [];
  for (const axis of ["S", "A", "B", "C"] as const) {
    const values = historyValues(axis, digitHistory);
    for (const family of ["size", "parity"] as const) {
      const model = trainBinaryModel(axis, family, values);
      if (model) models.push(model);
    }
  }
  if (models.length === 0) return null;
  return {
    version: MODEL_VERSION,
    trainedAt: Date.now(),
    historySize: digitHistory.length,
    models,
  };
}

export function saveCanadaAiModel(bundle: CanadaAiModelBundle, filePath = DEFAULT_MODEL_PATH): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), "utf8");
}

export function loadCanadaAiModel(filePath = DEFAULT_MODEL_PATH): CanadaAiModelBundle | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as CanadaAiModelBundle;
    if (parsed.version !== MODEL_VERSION || !Array.isArray(parsed.models) || parsed.models.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function ensureCanadaAiModel(digitHistory: CanadaAiDigits[], filePath = DEFAULT_MODEL_PATH): CanadaAiModelBundle | null {
  const signature = historySignature(digitHistory);
  if (cachedBundle && cachedSignature === signature) return cachedBundle;

  const loaded = loadCanadaAiModel(filePath);
  const shouldRetrain = !loaded
    || loaded.historySize < Math.min(digitHistory.length, MIN_TRAIN_HISTORY)
    || loaded.historySize + 8 < digitHistory.length
    || loaded.models.length < 8;
  if (shouldRetrain) {
    logger.info({
      historySize: digitHistory.length,
      filePath,
      hadExistingModel: !!loaded,
    }, "[canada-ai] retraining model");
  } else if (loaded) {
    logger.info({
      historySize: loaded.historySize,
      trainedAt: loaded.trainedAt,
      filePath,
    }, "[canada-ai] loaded existing model");
  }
  const bundle = shouldRetrain ? trainCanadaAiModel(digitHistory) : loaded;
  if (!bundle) return null;
  if (shouldRetrain) {
    saveCanadaAiModel(bundle, filePath);
    logger.info({
      filePath,
      historySize: bundle.historySize,
      models: bundle.models.length,
      trainedAt: bundle.trainedAt,
    }, "[canada-ai] model saved");
  }
  cachedBundle = bundle;
  cachedSignature = signature;
  return bundle;
}

function predictFromModel(model: CanadaAiBinaryModel, values: number[]): CanadaAiSignal {
  const feature = buildFeature(model.axis, model.family, values);
  const vector = featureVector(feature);
  let z = model.bias;
  for (let i = 0; i < vector.length; i++) z += model.weights[i]! * vector[i]!;
  const positiveProb = sigmoid(z);
  const negativeAttr = oppositeAttr(model.positiveAttr, model.family);
  const targetAttr = positiveProb >= 0.5 ? model.positiveAttr : negativeAttr;
  const targetProb = targetAttr === model.positiveAttr ? positiveProb : 1 - positiveProb;
  const last = feature.labels[feature.labels.length - 1] ?? targetAttr;
  const prev = feature.labels[feature.labels.length - 2] ?? null;
  let tag: CanadaAiTag;
  if (targetAttr !== last) {
    tag = feature.altRatio >= 0.56 || prev === targetAttr ? "震荡" : "逆势";
  } else {
    tag = targetProb >= 0.68
      && (targetAttr === model.positiveAttr ? feature.tailPositive >= 2 : feature.tailNegative >= 2)
      ? "顺势"
      : feature.altRatio >= 0.56
        ? "震荡"
        : "顺势";
  }
  const strength = Math.max(1, targetProb * 8 + model.accuracy * 3 + Math.abs(positiveProb - 0.5) * 3.5);
  const confidence = Math.round(clamp(48 + (targetProb - 0.5) * 42 + (model.accuracy - 0.5) * 18, 48, 86));
  return {
    axis: model.axis,
    family: model.family,
    bet: `${model.axis}${targetAttr}`,
    tag,
    confidence,
    strength,
    probability: targetProb,
    accuracy: model.accuracy,
  };
}

function buildAlternativeSignal(signal: CanadaAiSignal): CanadaAiSignal {
  const family = signal.family;
  const attr = signal.bet.slice(1) as CanadaAiAttr;
  const opposite = oppositeAttr(attr, family);
  const tag: CanadaAiTag = signal.tag === "顺势" ? "逆势" : signal.tag === "逆势" ? "顺势" : "震荡";
  return {
    ...signal,
    bet: `${signal.axis}${opposite}`,
    tag,
    confidence: Math.round(clamp(signal.confidence - (signal.tag === "顺势" ? 10 : 7), 42, 72)),
    strength: Math.max(0.8, signal.strength - (signal.tag === "顺势" ? 1.4 : 0.9)),
    probability: 1 - signal.probability,
  };
}

export function predictCanadaAiAxisSignals(axis: CanadaAiAxis, digitHistory: CanadaAiDigits[], filePath = DEFAULT_MODEL_PATH): CanadaAiSignal[] {
  const bundle = ensureCanadaAiModel(digitHistory, filePath);
  if (!bundle) return [];
  const values = historyValues(axis, digitHistory);
  return bundle.models
    .filter(model => model.axis === axis)
    .map(model => predictFromModel(model, values))
    .flatMap(signal => [signal, buildAlternativeSignal(signal)]);
}

export function getCanadaAiModelPath(): string {
  return DEFAULT_MODEL_PATH;
}

type CanadaAiRemoteDrawItem = {
  term?: number;
  r3?: string;
  sum1?: number;
  sum2?: number;
  sum3?: number;
};

function extractRemoteDigits(item: CanadaAiRemoteDrawItem): CanadaAiDigits | null {
  const digits = [item.sum1, item.sum2, item.sum3].map(v => Number(v));
  if (digits.some(v => !Number.isInteger(v) || v < 0 || v > 9)) return null;
  return digits as CanadaAiDigits;
}

export async function fetchCanadaAiRemoteHistory(): Promise<CanadaAiDigits[]> {
  const res = await fetch("http://pc20.net/api/fengpan", {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "http://pc20.net/",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const data = await res.json() as { message?: { all?: { keno28?: { data?: CanadaAiRemoteDrawItem[] } } } };
  const items = data?.message?.all?.keno28?.data ?? [];
  return items
    .map(extractRemoteDigits)
    .filter((item): item is CanadaAiDigits => item !== null)
    .reverse();
}

export async function warmupCanadaAiModel(filePath = DEFAULT_MODEL_PATH): Promise<CanadaAiModelBundle | null> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    logger.info({ filePath }, "[canada-ai] warmup started");
    try {
      const digitHistory = await fetchCanadaAiRemoteHistory();
      logger.info({ historySize: digitHistory.length }, "[canada-ai] history fetched");
      const bundle = ensureCanadaAiModel(digitHistory, filePath);
      if (!bundle) {
        logger.warn({ historySize: digitHistory.length }, "[canada-ai] warmup skipped, insufficient history");
        return null;
      }
      logger.info({
        filePath,
        historySize: bundle.historySize,
        models: bundle.models.length,
        trainedAt: bundle.trainedAt,
      }, "[canada-ai] warmup completed");
      return bundle;
    } catch (err) {
      logger.error({ err, filePath }, "[canada-ai] warmup failed");
      return null;
    } finally {
      warmupPromise = null;
    }
  })();
  return warmupPromise;
}
