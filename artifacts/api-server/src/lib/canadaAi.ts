import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCanadaTrueAiSequenceDataset,
  completeCanadaTrueAiTrainingJob,
  createCanadaTrueAiTrainingJob,
  DEFAULT_TRUE_AI_MODEL_PATH,
  failCanadaTrueAiTrainingJob,
  saveCanadaTrueAiModel,
  trainCanadaTrueAiModel,
} from "./canadaTrueAi";
import { logger } from "./logger";

export type CanadaAiAxis = "A" | "B" | "C" | "S";
export type CanadaAiFamily = "size" | "parity";
export type CanadaAiAttr = "大" | "小" | "单" | "双";
export type CanadaAiTag = "顺势" | "逆势" | "震荡";
export type CanadaAiDigits = [number, number, number];
type CanadaAiExtreme = "极大" | "极小" | "无";
type CanadaAiPattern = "豹子" | "对子" | "杂六";
type CanadaAiDragonTiger = "龙" | "虎" | "合";
type CanadaAiEdge = "大边" | "小边" | "中";

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

export interface CanadaAiLogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}

export interface CanadaAiAdminStatus {
  phase: "idle" | "training" | "ready" | "error";
  modelPath: string;
  modelExists: boolean;
  lastSource: string | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastTrainedAt: number | null;
  lastHistorySize: number;
  modelCount: number;
  lastAccuracyAvg: number | null;
  lastError: string | null;
  recentLogs: CanadaAiLogEntry[];
}

export interface CanadaAiChannelHistoryEntry {
  msgId: number;
  term: number | null;
  digits: CanadaAiDigits;
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
  lastA: number;
  lastB: number;
  lastC: number;
  lastSum: number;
  shortAvgSum: number;
  extremeBigRatio: number;
  extremeSmallRatio: number;
  pairRatio: number;
  leopardRatio: number;
  mixedRatio: number;
  dragonRatio: number;
  tigerRatio: number;
  tieRatio: number;
  edgeBigRatio: number;
  edgeSmallRatio: number;
  edgeMidRatio: number;
  lastPatternPair: number;
  lastPatternLeopard: number;
  lastDragon: number;
  lastTiger: number;
  lastEdgeBig: number;
  lastEdgeSmall: number;
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
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL_PATH = path.resolve(MODULE_DIR, "..", "..", "model-data", "canada-ai-model.json");
const DEFAULT_CHANNEL_HISTORY_PATH = path.resolve(MODULE_DIR, "..", "..", "model-data", "canada-ai-channel-history.json");
const REMOTE_HISTORY_PAGES = 8;

let cachedBundle: CanadaAiModelBundle | null = null;
let cachedSignature = "";
let warmupPromise: Promise<CanadaAiModelBundle | null> | null = null;
const canadaAiLogs: CanadaAiLogEntry[] = [];
const canadaAiStatus: CanadaAiAdminStatus = {
  phase: "idle",
  modelPath: DEFAULT_MODEL_PATH,
  modelExists: fs.existsSync(DEFAULT_MODEL_PATH),
  lastSource: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastTrainedAt: null,
  lastHistorySize: 0,
  modelCount: 0,
  lastAccuracyAvg: null,
  lastError: null,
  recentLogs: canadaAiLogs,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function averageAccuracy(models: CanadaAiBinaryModel[]): number | null {
  if (models.length === 0) return null;
  return models.reduce((sum, item) => sum + item.accuracy, 0) / models.length;
}

function pushCanadaAiLog(level: CanadaAiLogEntry["level"], message: string, meta?: Record<string, unknown>) {
  canadaAiLogs.unshift({ ts: Date.now(), level, message, ...(meta ? { meta } : {}) });
  if (canadaAiLogs.length > 40) canadaAiLogs.length = 40;
}

function logCanadaAi(level: CanadaAiLogEntry["level"], message: string, meta?: Record<string, unknown>) {
  pushCanadaAiLog(level, message, meta);
  if (level === "error") logger.error(meta ?? {}, message);
  else if (level === "warn") logger.warn(meta ?? {}, message);
  else logger.info(meta ?? {}, message);
}

export function addCanadaAiAdminLog(
  level: CanadaAiLogEntry["level"],
  message: string,
  meta?: Record<string, unknown>,
): void {
  logCanadaAi(level, message, meta);
}

export function setCanadaAiAdminSource(source: string | null): void {
  canadaAiStatus.lastSource = source;
}

export function patchCanadaAiAdminStatus(patch: Partial<CanadaAiAdminStatus>): void {
  Object.assign(canadaAiStatus, patch);
}

function normalizeChannelHistoryEntries(entries: CanadaAiChannelHistoryEntry[]): CanadaAiChannelHistoryEntry[] {
  return [...entries]
    .filter(item =>
      Number.isInteger(item.msgId)
      && item.msgId > 0
      && Array.isArray(item.digits)
      && item.digits.length === 3
      && item.digits.every(v => Number.isInteger(v) && v >= 0 && v <= 9),
    )
    .sort((a, b) => a.msgId - b.msgId);
}

export function loadCanadaAiChannelHistory(
  filePath = DEFAULT_CHANNEL_HISTORY_PATH,
): CanadaAiChannelHistoryEntry[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as CanadaAiChannelHistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    return normalizeChannelHistoryEntries(parsed);
  } catch {
    return [];
  }
}

export function saveCanadaAiChannelHistory(
  entries: CanadaAiChannelHistoryEntry[],
  filePath = DEFAULT_CHANNEL_HISTORY_PATH,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalizeChannelHistoryEntries(entries), null, 2), "utf8");
}

export function mergeCanadaAiChannelHistory(
  currentEntries: CanadaAiChannelHistoryEntry[],
  incomingEntries: CanadaAiChannelHistoryEntry[],
): CanadaAiChannelHistoryEntry[] {
  const merged = new Map<number, CanadaAiChannelHistoryEntry>();
  for (const item of normalizeChannelHistoryEntries(currentEntries)) merged.set(item.msgId, item);
  for (const item of normalizeChannelHistoryEntries(incomingEntries)) merged.set(item.msgId, item);
  return [...merged.values()].sort((a, b) => a.msgId - b.msgId);
}

export function channelHistoryEntriesToDigits(entries: CanadaAiChannelHistoryEntry[]): CanadaAiDigits[] {
  const unique = new Map<string, CanadaAiDigits>();
  for (const item of normalizeChannelHistoryEntries(entries)) {
    const key = item.term ? String(item.term) : `${item.msgId}:${item.digits.join("")}`;
    unique.set(key, item.digits);
  }
  return [...unique.values()];
}

function updateCanadaAiReady(bundle: CanadaAiModelBundle, filePath: string) {
  canadaAiStatus.phase = "ready";
  canadaAiStatus.modelPath = filePath;
  canadaAiStatus.modelExists = fs.existsSync(filePath);
  canadaAiStatus.lastFinishedAt = Date.now();
  canadaAiStatus.lastTrainedAt = bundle.trainedAt;
  canadaAiStatus.lastHistorySize = bundle.historySize;
  canadaAiStatus.modelCount = bundle.models.length;
  canadaAiStatus.lastAccuracyAvg = averageAccuracy(bundle.models);
  canadaAiStatus.lastError = null;
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

function drawMeta([a, b, c]: CanadaAiDigits): {
  sum: number;
  extreme: CanadaAiExtreme;
  pattern: CanadaAiPattern;
  dragonTiger: CanadaAiDragonTiger;
  edge: CanadaAiEdge;
} {
  const sum = a + b + c;
  const pattern: CanadaAiPattern = a === b && b === c
    ? "豹子"
    : (a === b || a === c || b === c)
      ? "对子"
      : "杂六";
  const dragonTiger: CanadaAiDragonTiger = a === c ? "合" : a > c ? "龙" : "虎";
  const extreme: CanadaAiExtreme = sum >= 22 ? "极大" : sum <= 5 ? "极小" : "无";
  const edge: CanadaAiEdge = sum >= 18 ? "大边" : sum <= 9 ? "小边" : "中";
  return { sum, extreme, pattern, dragonTiger, edge };
}

function buildFeature(axis: CanadaAiAxis, family: CanadaAiFamily, digitHistory: CanadaAiDigits[]): CanadaAiFeature {
  const values = historyValues(axis, digitHistory);
  const labels = values.map(value => digitLabel(axis, family, value));
  const [positiveAttr, negativeAttr] = familyAttrs(family);
  const short = labels.slice(-8);
  const mid = labels.slice(-14);
  const long = labels.slice(-24);
  const recentDraws = digitHistory.slice(-12);
  const metas = recentDraws.map(drawMeta);
  const lastDraw = recentDraws[recentDraws.length - 1] ?? digitHistory[digitHistory.length - 1] ?? [0, 0, 0];
  const lastMeta = drawMeta(lastDraw);
  const ratio = (items: CanadaAiAttr[], attr: CanadaAiAttr) => items.length > 0
    ? items.filter(item => item === attr).length / items.length
    : 0;
  const metaRatio = <T extends string>(items: T[], target: T) => items.length > 0
    ? items.filter(item => item === target).length / items.length
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

  const patterns = metas.map(item => item.pattern);
  const dragonTigers = metas.map(item => item.dragonTiger);
  const edges = metas.map(item => item.edge);
  const extremes = metas.map(item => item.extreme);
  const shortAvgSum = metas.length > 0
    ? metas.reduce((sum, item) => sum + item.sum, 0) / metas.length / 27
    : 0;

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
    lastA: lastDraw[0] / 9,
    lastB: lastDraw[1] / 9,
    lastC: lastDraw[2] / 9,
    lastSum: lastMeta.sum / 27,
    shortAvgSum,
    extremeBigRatio: metaRatio(extremes, "极大"),
    extremeSmallRatio: metaRatio(extremes, "极小"),
    pairRatio: metaRatio(patterns, "对子"),
    leopardRatio: metaRatio(patterns, "豹子"),
    mixedRatio: metaRatio(patterns, "杂六"),
    dragonRatio: metaRatio(dragonTigers, "龙"),
    tigerRatio: metaRatio(dragonTigers, "虎"),
    tieRatio: metaRatio(dragonTigers, "合"),
    edgeBigRatio: metaRatio(edges, "大边"),
    edgeSmallRatio: metaRatio(edges, "小边"),
    edgeMidRatio: metaRatio(edges, "中"),
    lastPatternPair: lastMeta.pattern === "对子" ? 1 : 0,
    lastPatternLeopard: lastMeta.pattern === "豹子" ? 1 : 0,
    lastDragon: lastMeta.dragonTiger === "龙" ? 1 : 0,
    lastTiger: lastMeta.dragonTiger === "虎" ? 1 : 0,
    lastEdgeBig: lastMeta.edge === "大边" ? 1 : 0,
    lastEdgeSmall: lastMeta.edge === "小边" ? 1 : 0,
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
    feature.lastA,
    feature.lastB,
    feature.lastC,
    feature.lastSum,
    feature.shortAvgSum,
    feature.extremeBigRatio,
    feature.extremeSmallRatio,
    feature.pairRatio,
    feature.leopardRatio,
    feature.mixedRatio,
    feature.dragonRatio,
    feature.tigerRatio,
    feature.tieRatio,
    feature.edgeBigRatio,
    feature.edgeSmallRatio,
    feature.edgeMidRatio,
    feature.lastPatternPair,
    feature.lastPatternLeopard,
    feature.lastDragon,
    feature.lastTiger,
    feature.lastEdgeBig,
    feature.lastEdgeSmall,
  ];
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-18, Math.min(18, value))));
}

function trainBinaryModel(axis: CanadaAiAxis, family: CanadaAiFamily, digitHistory: CanadaAiDigits[]): CanadaAiBinaryModel | null {
  if (digitHistory.length < MIN_TRAIN_HISTORY) return null;
  const values = historyValues(axis, digitHistory);
  const [positiveAttr] = familyAttrs(family);
  const rows: number[][] = [];
  const labels: number[] = [];
  for (let i = FEATURE_START_INDEX; i < values.length; i++) {
    const feature = buildFeature(axis, family, digitHistory.slice(0, i));
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
    for (const family of ["size", "parity"] as const) {
      const model = trainBinaryModel(axis, family, digitHistory);
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
    canadaAiStatus.phase = "training";
    canadaAiStatus.lastStartedAt = Date.now();
    canadaAiStatus.modelPath = filePath;
    canadaAiStatus.modelExists = !!loaded && fs.existsSync(filePath);
    canadaAiStatus.lastHistorySize = digitHistory.length;
    logCanadaAi("info", "[canada-ai] retraining model", {
      historySize: digitHistory.length,
      filePath,
      hadExistingModel: !!loaded,
    });
  } else if (loaded) {
    updateCanadaAiReady(loaded, filePath);
    logCanadaAi("info", "[canada-ai] loaded existing model", {
      historySize: loaded.historySize,
      trainedAt: loaded.trainedAt,
      filePath,
    });
  }
  const bundle = shouldRetrain ? trainCanadaAiModel(digitHistory) : loaded;
  if (!bundle) return null;
  if (shouldRetrain) {
    saveCanadaAiModel(bundle, filePath);
    updateCanadaAiReady(bundle, filePath);
    logCanadaAi("info", "[canada-ai] model saved", {
      filePath,
      historySize: bundle.historySize,
      models: bundle.models.length,
      trainedAt: bundle.trainedAt,
      accuracyAvg: averageAccuracy(bundle.models),
    });
  }
  cachedBundle = bundle;
  cachedSignature = signature;
  return bundle;
}

function predictFromModel(model: CanadaAiBinaryModel, digitHistory: CanadaAiDigits[]): CanadaAiSignal {
  const values = historyValues(model.axis, digitHistory);
  const feature = buildFeature(model.axis, model.family, digitHistory);
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
  return bundle.models
    .filter(model => model.axis === axis)
    .map(model => predictFromModel(model, digitHistory))
    .flatMap(signal => [signal, buildAlternativeSignal(signal)]);
}

export function getCanadaAiModelPath(): string {
  return DEFAULT_MODEL_PATH;
}

export function getCanadaAiAdminStatus(): CanadaAiAdminStatus {
  const loaded = loadCanadaAiModel(DEFAULT_MODEL_PATH);
  if (loaded && canadaAiStatus.phase === "idle") {
    updateCanadaAiReady(loaded, DEFAULT_MODEL_PATH);
  } else {
    canadaAiStatus.modelExists = fs.existsSync(canadaAiStatus.modelPath);
  }
  return {
    ...canadaAiStatus,
    recentLogs: [...canadaAiLogs],
  };
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
  const allItems: CanadaAiRemoteDrawItem[] = [];
  for (let page = 1; page <= REMOTE_HISTORY_PAGES; page++) {
    const url = page === 1 ? "http://pc20.net/api/fengpan" : `http://pc20.net/api/fengpan?page=${page}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "http://pc20.net/",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const data = await res.json() as { message?: { all?: { keno28?: { data?: CanadaAiRemoteDrawItem[] } } } };
    const items = data?.message?.all?.keno28?.data ?? [];
    if (!items.length) break;
    allItems.push(...items);
    if (items.length < 30) break;
  }
  const unique = new Map<string, CanadaAiDigits>();
  for (const item of allItems) {
    const digits = extractRemoteDigits(item);
    if (!digits) continue;
    const key = `${item.term ?? ""}-${digits.join("")}`;
    unique.set(key, digits);
  }
  return [...unique.values()].reverse();
}

export async function warmupCanadaAiModel(filePath = DEFAULT_MODEL_PATH): Promise<CanadaAiModelBundle | null> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    canadaAiStatus.phase = "training";
    canadaAiStatus.lastStartedAt = Date.now();
    canadaAiStatus.modelPath = filePath;
    canadaAiStatus.lastSource = "remote-api";
    canadaAiStatus.lastError = null;
    logCanadaAi("info", "[canada-ai] warmup started", { filePath });
    try {
      const digitHistory = await fetchCanadaAiRemoteHistory();
      logCanadaAi("info", "[canada-ai] history fetched", { historySize: digitHistory.length });
      const bundle = ensureCanadaAiModel(digitHistory, filePath);
      if (!bundle) {
        canadaAiStatus.phase = "error";
        canadaAiStatus.lastFinishedAt = Date.now();
        canadaAiStatus.lastHistorySize = digitHistory.length;
        canadaAiStatus.lastError = "insufficient history";
        logCanadaAi("warn", "[canada-ai] warmup skipped, insufficient history", { historySize: digitHistory.length });
        return null;
      }
      updateCanadaAiReady(bundle, filePath);
      logCanadaAi("info", "[canada-ai] warmup completed", {
        filePath,
        historySize: bundle.historySize,
        models: bundle.models.length,
        trainedAt: bundle.trainedAt,
        accuracyAvg: averageAccuracy(bundle.models),
      });
      return bundle;
    } catch (err) {
      canadaAiStatus.phase = "error";
      canadaAiStatus.lastFinishedAt = Date.now();
      canadaAiStatus.modelPath = filePath;
      canadaAiStatus.modelExists = fs.existsSync(filePath);
      canadaAiStatus.lastError = normalizeErrorMessage(err);
      logCanadaAi("error", "[canada-ai] warmup failed", {
        filePath,
        error: normalizeErrorMessage(err),
      });
      return null;
    } finally {
      warmupPromise = null;
    }
  })();
  return warmupPromise;
}

export async function warmupCanadaAiModelFromHistory(
  digitHistory: CanadaAiDigits[],
  source: string,
  filePath = DEFAULT_MODEL_PATH,
): Promise<CanadaAiModelBundle | null> {
  canadaAiStatus.phase = "training";
  canadaAiStatus.lastStartedAt = Date.now();
  canadaAiStatus.modelPath = filePath;
  canadaAiStatus.lastSource = source;
  canadaAiStatus.lastError = null;
  logCanadaAi("info", "[canada-ai] history warmup started", { source, historySize: digitHistory.length, filePath });
  const dataset = buildCanadaTrueAiSequenceDataset(digitHistory);
  const jobId = await createCanadaTrueAiTrainingJob({
    source,
    trigger: "history-warmup",
    historySize: digitHistory.length,
    lookback: dataset.summary.lookback,
  });
  try {
    const bundle = ensureCanadaAiModel(digitHistory, filePath);
    if (!bundle) {
      canadaAiStatus.phase = "error";
      canadaAiStatus.lastFinishedAt = Date.now();
      canadaAiStatus.lastHistorySize = digitHistory.length;
      canadaAiStatus.lastError = "insufficient history";
      await failCanadaTrueAiTrainingJob(jobId, "insufficient history");
      logCanadaAi("warn", "[canada-ai] history warmup skipped, insufficient history", { source, historySize: digitHistory.length });
      return null;
    }
    updateCanadaAiReady(bundle, filePath);
    canadaAiStatus.lastSource = source;
    const trueBundle = trainCanadaTrueAiModel(digitHistory);
    if (trueBundle) saveCanadaTrueAiModel(trueBundle, DEFAULT_TRUE_AI_MODEL_PATH);
    const trueAiAccuracyAvg = trueBundle && trueBundle.heads.length > 0
      ? trueBundle.heads.reduce((sum, head) => sum + head.accuracy, 0) / trueBundle.heads.length
      : null;
    const trueAiAccuracyMin = trueBundle && trueBundle.heads.length > 0
      ? trueBundle.heads.reduce((min, head) => Math.min(min, head.accuracy), trueBundle.heads[0]!.accuracy)
      : null;
    await completeCanadaTrueAiTrainingJob({
      jobId,
      historySize: bundle.historySize,
      artifactPath: trueBundle ? DEFAULT_TRUE_AI_MODEL_PATH : filePath,
      activate: true,
      metrics: {
        modelCount: bundle.models.length,
        accuracyAvg: averageAccuracy(bundle.models),
        trainedAt: bundle.trainedAt,
        dataset: dataset.summary,
        trueAiHistorySize: trueBundle?.historySize ?? 0,
        trueAiHeadCount: trueBundle?.heads.length ?? 0,
        trueAiAccuracyAvg,
        trueAiAccuracyMin,
      },
    });
    logCanadaAi("info", "[canada-ai] history warmup completed", {
      source,
      historySize: bundle.historySize,
      models: bundle.models.length,
      trainedAt: bundle.trainedAt,
      accuracyAvg: averageAccuracy(bundle.models),
      filePath,
    });
    return bundle;
  } catch (err) {
    canadaAiStatus.phase = "error";
    canadaAiStatus.lastFinishedAt = Date.now();
    canadaAiStatus.modelPath = filePath;
    canadaAiStatus.modelExists = fs.existsSync(filePath);
    canadaAiStatus.lastError = normalizeErrorMessage(err);
    canadaAiStatus.lastSource = source;
    await failCanadaTrueAiTrainingJob(jobId, normalizeErrorMessage(err));
    logCanadaAi("error", "[canada-ai] history warmup failed", {
      source,
      filePath,
      error: normalizeErrorMessage(err),
    });
    return null;
  }
}
