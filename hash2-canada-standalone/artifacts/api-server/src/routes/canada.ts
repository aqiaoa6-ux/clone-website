import { Router } from "express";
import { Api } from "telegram";
import fs from "fs";
import os from "os";
import path from "path";
import { requireCard } from "../middleware/requireAuth";
import { logger } from "../lib/logger";
import { tgSessions, type TgSession } from "./telegram";

const router = Router();

type CanadaFormat = "amount_first" | "target_first";

interface CanadaPlan {
  id: string;
  name: string;
  enabled: boolean;
  bets: string[];
  baseAmount: number;
  handCount: number;
  amountLevels: number[];
  stopLoss: number;
  targetProfit: number;
  zeroAmountRuns: boolean;
  format: CanadaFormat;
  webAlertEnabled: boolean;
  voiceAlertEnabled: boolean;
  basicOdds: Record<string, number>;
  comboOdds: Record<string, number>;
  numberOdds: Record<string, number>;
  specialOdds: Record<string, number>;
}

interface CanadaConfig {
  plans: CanadaPlan[];
  updatedAt: number;
}

type CanadaAlertLevel = "info" | "warn" | "success" | "error";

interface CanadaPlanRuntime {
  currentLevel: number;
  betLevels: Record<string, number>;
  sessionPnl: number;
  totalRounds: number;
  wins: number;
  losses: number;
  pendingPeriod: string | null;
  lastSentPeriod: string | null;
  lastSettledPeriod: string | null;
  pendingAmount: number;
  pendingAmounts: Record<string, number>;
  lastMessage: string;
  blockedReason?: string;
  lastHit?: string;
  updatedAt: number;
}

interface CanadaAlert {
  id: string;
  planId: string;
  planName: string;
  message: string;
  at: number;
  level: CanadaAlertLevel;
  voice: boolean;
}

interface CanadaRuntime {
  plans: Record<string, CanadaPlanRuntime>;
  lastChannelMsgId: number;
  activePeriod: string | null;
  lastAlert?: CanadaAlert;
  updatedAt: number;
}

interface ParsedCanadaResult {
  period: string;
  parts?: [number, number, number];
  value: number;
  label: string;
}

const HASH2_MAX_PLANS = 5;
const HASH2_MAX_HANDS = 60;
const HASH2_DEFAULT_LEVELS = Array.from({ length: HASH2_MAX_HANDS }, (_, i) => i + 1);
const HASH2_RESULT_CHANNEL = "pc28";
const HASH2_ALLOWED_BETS = new Set([
  "big", "small", "odd", "even",
  "big-odd", "big-even", "small-odd", "small-even",
  "extreme-big", "extreme-small", "leopard", "pair", "straight",
  ...Array.from({ length: 28 }, (_, i) => `num:${i}`),
]);
const HASH2_DEFAULT_NUMBER_ODDS: Record<string, number> = {
  "0": 888, "1": 288, "2": 136, "3": 86, "4": 48, "5": 38, "6": 32, "7": 26,
  "8": 20, "9": 17, "10": 15, "11": 14, "12": 13, "13": 12, "14": 12, "15": 13,
  "16": 14, "17": 15, "18": 17, "19": 20, "20": 26, "21": 32, "22": 38, "23": 48,
  "24": 86, "25": 136, "26": 288, "27": 888,
};
const HASH2_DEFAULT_BASIC_ODDS: Record<string, number> = {
  big: 2,
  small: 2,
  odd: 2,
  even: 2,
};
const HASH2_DEFAULT_COMBO_ODDS: Record<string, number> = {
  "big-odd": 4.2,
  "big-even": 4.2,
  "small-odd": 4.2,
  "small-even": 4.2,
};
const HASH2_DEFAULT_SPECIAL_ODDS: Record<string, number> = {
  "extreme-big": 15,
  "extreme-small": 15,
  leopard: 88,
  pair: 3.4,
  straight: 18,
};
const canadaLoopInFlight = new Set<number>();
const canadaBetDelayTimers = new Map<number, ReturnType<typeof setTimeout>>();
let cachedDataDir: string | null = null;

function tryEnsureWritableDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    fs.writeFileSync(probe, "1", "utf-8");
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    logger.warn({ dir, err }, "[canada] data dir not writable");
    return false;
  }
}

function dataDir(): string {
  if (cachedDataDir) return cachedDataDir;
  const candidates = [
    process.env.DATA_DIR,
    process.env.RENDER_DISK_PATH,
    path.join(process.cwd(), "data"),
    path.join(os.tmpdir(), "hash2-canada"),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  for (const dir of candidates) {
    if (tryEnsureWritableDir(dir)) {
      cachedDataDir = dir;
      return dir;
    }
  }

  throw new Error("数据目录不可写");
}

function canadaFile(userId: number): string {
  return path.join(dataDir(), `.canada-${userId}.json`);
}

function defaultPlan(index: number): CanadaPlan {
  return {
    id: `plan-${index + 1}`,
    name: `方案${index + 1}`,
    enabled: false,
    bets: [],
    baseAmount: 0,
    handCount: HASH2_MAX_HANDS,
    amountLevels: [...HASH2_DEFAULT_LEVELS],
    stopLoss: 0,
    targetProfit: 0,
    zeroAmountRuns: true,
    format: "target_first",
    webAlertEnabled: true,
    voiceAlertEnabled: true,
    basicOdds: { ...HASH2_DEFAULT_BASIC_ODDS },
    comboOdds: { ...HASH2_DEFAULT_COMBO_ODDS },
    numberOdds: { ...HASH2_DEFAULT_NUMBER_ODDS },
    specialOdds: { ...HASH2_DEFAULT_SPECIAL_ODDS },
  };
}

function defaultConfig(): CanadaConfig {
  return {
    plans: Array.from({ length: HASH2_MAX_PLANS }, (_, i) => defaultPlan(i)),
    updatedAt: Date.now(),
  };
}

function normalizeLevels(levels: number[] | undefined, handCount: number): number[] {
  const next = Array.from({ length: HASH2_MAX_HANDS }, (_, i) => {
    const raw = Number(levels?.[i] ?? HASH2_DEFAULT_LEVELS[i]!);
    return Number.isFinite(raw) && raw >= 0 ? raw : HASH2_DEFAULT_LEVELS[i]!;
  });
  if (handCount > 0) return next;
  return [...HASH2_DEFAULT_LEVELS];
}

function normalizeNumberOdds(input: Record<string, number> | undefined): Record<string, number> {
  const next: Record<string, number> = {};
  for (let i = 0; i <= 27; i++) {
    const key = String(i);
    const raw = Number(input?.[key] ?? HASH2_DEFAULT_NUMBER_ODDS[key]!);
    next[key] = Number.isFinite(raw) && raw >= 0 ? raw : HASH2_DEFAULT_NUMBER_ODDS[key]!;
  }
  return next;
}

function normalizeNamedOdds(defaults: Record<string, number>, input: Record<string, number> | undefined): Record<string, number> {
  const next: Record<string, number> = {};
  for (const key of Object.keys(defaults)) {
    const raw = Number(input?.[key] ?? defaults[key]!);
    next[key] = Number.isFinite(raw) && raw >= 0 ? raw : defaults[key]!;
  }
  return next;
}

function normalizeSpecialOdds(input: Record<string, number> | undefined): Record<string, number> {
  return normalizeNamedOdds(HASH2_DEFAULT_SPECIAL_ODDS, input);
}

function normalizePlan(input: Partial<CanadaPlan> | undefined, index: number): CanadaPlan {
  const fallback = defaultPlan(index);
  const handCountRaw = Number(input?.handCount ?? fallback.handCount);
  const handCount = Number.isInteger(handCountRaw)
    ? Math.min(Math.max(handCountRaw, 1), HASH2_MAX_HANDS)
    : fallback.handCount;
  const bets = Array.isArray(input?.bets)
    ? input!.bets.filter((bet): bet is string => typeof bet === "string" && HASH2_ALLOWED_BETS.has(bet))
    : fallback.bets;
  return {
    id: typeof input?.id === "string" && input.id ? input.id : fallback.id,
    name: typeof input?.name === "string" && input.name.trim() ? input.name.trim().slice(0, 20) : fallback.name,
    enabled: !!input?.enabled,
    bets: [...new Set(bets)],
    baseAmount: Math.max(0, Number(input?.baseAmount ?? fallback.baseAmount) || 0),
    handCount,
    amountLevels: normalizeLevels(input?.amountLevels, handCount),
    stopLoss: Math.max(0, Number(input?.stopLoss ?? fallback.stopLoss) || 0),
    targetProfit: Math.max(0, Number(input?.targetProfit ?? fallback.targetProfit) || 0),
    zeroAmountRuns: input?.zeroAmountRuns !== undefined ? !!input.zeroAmountRuns : fallback.zeroAmountRuns,
    format: input?.format === "amount_first" ? "amount_first" : "target_first",
    webAlertEnabled: input?.webAlertEnabled !== undefined ? !!input.webAlertEnabled : fallback.webAlertEnabled,
    voiceAlertEnabled: input?.voiceAlertEnabled !== undefined ? !!input.voiceAlertEnabled : fallback.voiceAlertEnabled,
    basicOdds: normalizeNamedOdds(HASH2_DEFAULT_BASIC_ODDS, input?.basicOdds),
    comboOdds: normalizeNamedOdds(HASH2_DEFAULT_COMBO_ODDS, input?.comboOdds),
    numberOdds: normalizeNumberOdds(input?.numberOdds),
    specialOdds: normalizeSpecialOdds(input?.specialOdds),
  };
}

function normalizeConfig(input: Partial<CanadaConfig> | undefined): CanadaConfig {
  const plans = Array.from({ length: HASH2_MAX_PLANS }, (_, i) => normalizePlan(input?.plans?.[i], i));
  return {
    plans,
    updatedAt: Date.now(),
  };
}

function loadConfig(userId: number): CanadaConfig {
  try {
    const file = canadaFile(userId);
    if (!fs.existsSync(file)) return defaultConfig();
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<CanadaConfig>;
    return normalizeConfig(raw);
  } catch {
    return defaultConfig();
  }
}

function saveConfig(userId: number, config: CanadaConfig): void {
  fs.writeFileSync(canadaFile(userId), JSON.stringify(config, null, 2), "utf-8");
}

function runtimeFile(userId: number): string {
  return path.join(dataDir(), `.canada-runtime-${userId}.json`);
}

function defaultPlanRuntime(): CanadaPlanRuntime {
  return {
    currentLevel: 0,
    betLevels: {},
    sessionPnl: 0,
    totalRounds: 0,
    wins: 0,
    losses: 0,
    pendingPeriod: null,
    lastSentPeriod: null,
    lastSettledPeriod: null,
    pendingAmount: 0,
    pendingAmounts: {},
    lastMessage: "",
    updatedAt: Date.now(),
  };
}

function normalizeRuntime(input: Partial<CanadaRuntime> | undefined, config: CanadaConfig): CanadaRuntime {
  const plans: Record<string, CanadaPlanRuntime> = {};
  for (const plan of config.plans) {
    const existing = input?.plans?.[plan.id];
    const legacyLevel = Math.max(Number(existing?.currentLevel ?? 0) || 0, 0);
    const legacyPendingAmount = Math.max(Number(existing?.pendingAmount ?? 0) || 0, 0);
    const levelState = normalizePlanLevelState(
      plan,
      existing?.betLevels,
      existing?.pendingAmounts,
      legacyLevel,
      legacyPendingAmount,
    );
    plans[plan.id] = {
      ...defaultPlanRuntime(),
      ...existing,
      ...levelState,
      sessionPnl: Number(existing?.sessionPnl ?? 0) || 0,
      totalRounds: Number(existing?.totalRounds ?? 0) || 0,
      wins: Number(existing?.wins ?? 0) || 0,
      losses: Number(existing?.losses ?? 0) || 0,
      updatedAt: Date.now(),
    };
  }
  return {
    plans,
    lastChannelMsgId: Number(input?.lastChannelMsgId ?? 0) || 0,
    activePeriod: input?.activePeriod ?? null,
    lastAlert: input?.lastAlert,
    updatedAt: Date.now(),
  };
}

function loadRuntime(userId: number, config: CanadaConfig): CanadaRuntime {
  try {
    const file = runtimeFile(userId);
    if (!fs.existsSync(file)) return normalizeRuntime(undefined, config);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<CanadaRuntime>;
    return normalizeRuntime(raw, config);
  } catch {
    return normalizeRuntime(undefined, config);
  }
}

function saveRuntime(userId: number, runtime: CanadaRuntime): void {
  fs.writeFileSync(runtimeFile(userId), JSON.stringify(runtime, null, 2), "utf-8");
}

function makeAlert(plan: CanadaPlan, message: string, level: CanadaAlertLevel): CanadaAlert {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    planId: plan.id,
    planName: plan.name,
    message,
    at: Date.now(),
    level,
    voice: plan.voiceAlertEnabled,
  };
}

function derivePlanCurrentLevel(levels: Record<string, number>): number {
  const values = Object.values(levels).filter(value => Number.isFinite(value));
  if (!values.length) return 0;
  return Math.max(...values.map(value => Math.max(0, Math.floor(value))));
}

function planLevelCount(plan: CanadaPlan): number {
  let lastConfiguredLevel = 0;
  for (let i = 0; i < Math.min(plan.amountLevels.length, HASH2_MAX_HANDS); i++) {
    const amount = Number(plan.amountLevels[i] ?? 0);
    if (Number.isFinite(amount) && amount > 0) lastConfiguredLevel = i + 1;
  }
  return Math.min(Math.max(Math.max(plan.handCount, lastConfiguredLevel), 1), HASH2_MAX_HANDS);
}

function normalizePlanLevelState(
  plan: CanadaPlan,
  existingLevels: Record<string, number> | undefined,
  existingPendingAmounts: Record<string, number> | undefined,
  legacyLevel: number,
  legacyPendingAmount: number,
): Pick<CanadaPlanRuntime, "betLevels" | "pendingAmounts" | "currentLevel" | "pendingAmount"> {
  const maxLevel = Math.max(planLevelCount(plan) - 1, 0);
  const derivedLevel = derivePlanCurrentLevel(existingLevels ?? {});
  const sharedLevel = Math.min(
    Math.max(Number.isFinite(derivedLevel) ? Math.max(derivedLevel, legacyLevel) : legacyLevel, 0),
    maxLevel,
  );
  const betLevels: Record<string, number> = {};
  const pendingAmounts: Record<string, number> = {};
  for (const key of plan.bets) {
    betLevels[key] = sharedLevel;
    const rawPendingAmount = Number(existingPendingAmounts?.[key] ?? legacyPendingAmount);
    pendingAmounts[key] = Number.isFinite(rawPendingAmount) && rawPendingAmount >= 0 ? rawPendingAmount : 0;
  }
  return {
    betLevels,
    pendingAmounts,
    currentLevel: sharedLevel,
    pendingAmount: Object.values(pendingAmounts).reduce((sum, amount) => sum + amount, 0),
  };
}

function levelStakeAmount(plan: CanadaPlan, level: number): number {
  const levelAmount = plan.amountLevels[level] ?? plan.baseAmount;
  if (Number.isFinite(levelAmount)) return Math.max(0, levelAmount);
  return Math.max(0, plan.baseAmount);
}

function stakeAmountForBet(plan: CanadaPlan, runtime: CanadaPlanRuntime, key: string): number {
  return levelStakeAmount(plan, runtime.currentLevel ?? 0);
}

function planRiskReason(plan: CanadaPlan, runtime: CanadaPlanRuntime): string | undefined {
  if (plan.stopLoss > 0 && runtime.sessionPnl <= -plan.stopLoss) {
    return `已达止损 ${plan.stopLoss}`;
  }
  if (plan.targetProfit > 0 && runtime.sessionPnl >= plan.targetProfit) {
    return `已达止盈 ${plan.targetProfit}`;
  }
  return undefined;
}

function betKeyLabel(key: string): string {
  if (key === "big") return "大";
  if (key === "small") return "小";
  if (key === "odd") return "单";
  if (key === "even") return "双";
  if (key === "big-odd") return "大单";
  if (key === "big-even") return "大双";
  if (key === "small-odd") return "小单";
  if (key === "small-even") return "小双";
  if (key === "extreme-big") return "极大";
  if (key === "extreme-small") return "极小";
  if (key === "leopard") return "豹子";
  if (key === "pair") return "对子";
  if (key === "straight") return "顺子";
  if (key.startsWith("num:")) return key.slice(4);
  return key;
}

function formatStake(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

function buildPlanMessage(plan: CanadaPlan, entries: Array<{ key: string; amount: number }>): string {
  const forceTargetFirst = entries.some(entry => entry.key.startsWith("num:"));
  const parts = entries.map(({ key, amount }) => {
    const label = betKeyLabel(key);
    const targetFirst = forceTargetFirst || plan.format === "target_first";
    return targetFirst ? `${label}/${formatStake(amount)}` : `${formatStake(amount)}/${label}`;
  });
  return parts.join("  ");
}

function isStraight(parts?: [number, number, number]): boolean {
  if (!parts) return false;
  const sorted = [...parts].sort((a, b) => a - b);
  return sorted[1] === sorted[0] + 1 && sorted[2] === sorted[1] + 1;
}

function isPair(parts?: [number, number, number]): boolean {
  if (!parts) return false;
  return new Set(parts).size === 2;
}

function isLeopard(parts?: [number, number, number]): boolean {
  if (!parts) return false;
  return new Set(parts).size === 1;
}

function evaluateBetKey(key: string, result: ParsedCanadaResult): boolean {
  const { value, label, parts } = result;
  if (key === "big") return value >= 14;
  if (key === "small") return value <= 13;
  if (key === "odd") return value % 2 === 1;
  if (key === "even") return value % 2 === 0;
  if (key === "big-odd") return label === "大单";
  if (key === "big-even") return label === "大双";
  if (key === "small-odd") return label === "小单";
  if (key === "small-even") return label === "小双";
  if (key === "extreme-big") return value >= 22;
  if (key === "extreme-small") return value <= 5;
  if (key === "pair") return isPair(parts);
  if (key === "straight") return isStraight(parts);
  if (key === "leopard") return isLeopard(parts);
  if (key.startsWith("num:")) return value === Number(key.slice(4));
  return false;
}

function payoutOdds(key: string, plan: CanadaPlan): number {
  if (key === "big" || key === "small" || key === "odd" || key === "even") {
    return plan.basicOdds[key] ?? HASH2_DEFAULT_BASIC_ODDS[key] ?? 0;
  }
  if (key === "big-odd" || key === "big-even" || key === "small-odd" || key === "small-even") {
    return plan.comboOdds[key] ?? HASH2_DEFAULT_COMBO_ODDS[key] ?? 0;
  }
  if (key === "extreme-big" || key === "extreme-small" || key === "pair" || key === "straight" || key === "leopard") {
    return plan.specialOdds[key] ?? HASH2_DEFAULT_SPECIAL_ODDS[key] ?? 0;
  }
  if (key.startsWith("num:")) return plan.numberOdds[key.slice(4)] ?? 0;
  return 0;
}

function parseChannelText(text: string): { type: "open"; period: string } | { type: "result"; result: ParsedCanadaResult } | null {
  const openMatch = text.match(/第\s*(\d{4,})\s*期\s*开始/);
  if (openMatch) {
    return { type: "open", period: openMatch[1]! };
  }
  const full = text.match(/(\d{4,})期\s*(\d+)[+＋](\d+)[+＋](\d+)[=＝](\d{1,2})\s*(大单|大双|小单|小双)/);
  if (full) {
    return {
      type: "result",
      result: {
        period: full[1]!,
        parts: [Number(full[2]!), Number(full[3]!), Number(full[4]!)] as [number, number, number],
        value: Number(full[5]!),
        label: full[6]!,
      },
    };
  }
  const partial = text.match(/(\d{4,})期[^\n]*?(\d{1,2})\s*(大单|大双|小单|小双)/);
  if (partial) {
    return {
      type: "result",
      result: {
        period: partial[1]!,
        value: Number(partial[2]!),
        label: partial[3]!,
      },
    };
  }
  return null;
}

async function triggerPlanForPeriod(session: TgSession, userId: number, plan: CanadaPlan, state: CanadaPlanRuntime, runtime: CanadaRuntime, period: string): Promise<void> {
  if (!plan.enabled || state.lastSentPeriod === period) return;
  Object.assign(
    state,
    normalizePlanLevelState(plan, state.betLevels, state.pendingAmounts, state.currentLevel, state.pendingAmount),
  );
  const riskReason = planRiskReason(plan, state);
  if (riskReason) {
    state.blockedReason = riskReason;
    state.lastSentPeriod = period;
    if (plan.webAlertEnabled) runtime.lastAlert = makeAlert(plan, `${plan.name} ${riskReason}`, riskReason.includes("止损") ? "error" : "success");
    return;
  }
  if (!session.watchGroupId || !session.me) {
    state.blockedReason = "TG未连接或未选择群组";
    return;
  }
  if (plan.bets.length === 0) {
    state.blockedReason = "未选择下注项";
    return;
  }
  const sharedAmount = stakeAmountForBet(plan, state, "");
  const entries = plan.bets.map(key => ({ key, amount: sharedAmount }));
  state.pendingAmounts = Object.fromEntries(entries.map(entry => [entry.key, entry.amount]));
  state.pendingAmount = entries.reduce((sum, entry) => sum + entry.amount, 0);
  state.pendingPeriod = period;
  state.lastSentPeriod = period;
  state.updatedAt = Date.now();
  state.blockedReason = undefined;
  const sendableEntries = entries.filter(entry => entry.amount > 0);
  if (sendableEntries.length === 0 && plan.zeroAmountRuns) {
    state.lastMessage = `[虚拟运行] ${buildPlanMessage(plan, entries.map(entry => ({ ...entry, amount: 0 })))}`
      .trim();
    return;
  }
  if (sendableEntries.length === 0) {
    state.blockedReason = "当前所有下注项金额都为0";
    return;
  }
  const message = buildPlanMessage(plan, sendableEntries);
  try {
    await session.client.sendMessage(session.watchGroupId, { message });
    state.lastMessage = message;
    logger.info({ userId, plan: plan.name, period, message }, "[canada] plan sent");
  } catch (err) {
    state.blockedReason = err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80);
    if (plan.webAlertEnabled) runtime.lastAlert = makeAlert(plan, `${plan.name} 发送失败：${state.blockedReason}`, "error");
  }
}

function settlePlanResult(plan: CanadaPlan, state: CanadaPlanRuntime, runtime: CanadaRuntime, result: ParsedCanadaResult): void {
  if (!plan.enabled) return;
  if (state.pendingPeriod !== result.period || state.lastSettledPeriod === result.period) return;

  Object.assign(
    state,
    normalizePlanLevelState(plan, state.betLevels, state.pendingAmounts, state.currentLevel, state.pendingAmount),
  );
  const maxLevel = Math.max(planLevelCount(plan) - 1, 0);
  let totalPnl = 0;
  const hits: string[] = [];
  for (const key of plan.bets) {
    const amount = Number(state.pendingAmounts[key] ?? 0) || 0;
    const won = evaluateBetKey(key, result);
    if (won) {
      totalPnl += amount * (payoutOdds(key, plan) - 1);
      hits.push(key);
    } else {
      totalPnl -= amount;
    }
  }

  state.sessionPnl += totalPnl;
  state.totalRounds += 1;
  if (hits.length > 0) {
    state.wins += 1;
    state.currentLevel = 0;
  } else {
    state.losses += 1;
    state.currentLevel = Math.min(state.currentLevel + 1, maxLevel);
  }
  for (const key of plan.bets) state.betLevels[key] = state.currentLevel;
  state.lastHit = hits.map(betKeyLabel).join(" / ");
  state.lastSettledPeriod = result.period;
  state.pendingPeriod = null;
  state.pendingAmounts = {};
  state.pendingAmount = 0;
  state.updatedAt = Date.now();

  const riskReason = planRiskReason(plan, state);
  if (riskReason) {
    state.blockedReason = riskReason;
    if (plan.webAlertEnabled) runtime.lastAlert = makeAlert(plan, `${plan.name} ${riskReason}`, riskReason.includes("止损") ? "error" : "success");
  } else {
    state.blockedReason = undefined;
  }
}

async function processUserCanada(session: TgSession): Promise<void> {
  const userId = session.userId;
  const config = loadConfig(userId);
  const enabledPlans = config.plans.filter(plan => plan.enabled);
  if (enabledPlans.length === 0) return;
  const runtime = loadRuntime(userId, config);
  const channel = HASH2_RESULT_CHANNEL as Parameters<typeof session.client.getMessages>[0];
  let changed = false;
  const prevMsgId = runtime.lastChannelMsgId;
  const prevActive = runtime.activePeriod;
  let parsedAny = false;
  let lastUnparsed = "";
  try {
    const msgs = await session.client.getMessages(channel, {
      limit: runtime.lastChannelMsgId > 0 ? 20 : 10,
      ...(runtime.lastChannelMsgId > 0 ? { minId: runtime.lastChannelMsgId } : {}),
    }) as Api.Message[];
    if (!msgs.length) {
      if (runtime.lastChannelMsgId === 0 && runtime.lastAlert?.id !== "canada_channel_empty") {
        const plan = enabledPlans[0]!;
        runtime.lastAlert = {
          id: "canada_channel_empty",
          planId: plan.id,
          planName: plan.name,
          message: "未读取到开奖频道 @pc28 的消息：请用当前 TG 账号先加入频道 @pc28（加入后等下一期开奖即可）。",
          at: Date.now(),
          level: "warn",
          voice: false,
        };
        changed = true;
      }
    }
    const sorted = [...msgs].sort((a, b) => a.id - b.id);
    for (const msg of sorted) {
      if (msg.id <= runtime.lastChannelMsgId) continue;
      runtime.lastChannelMsgId = msg.id;
      const text = msg.message ?? "";
      if (!text) continue;
      const parsed = parseChannelText(text);
      if (!parsed) {
        lastUnparsed = text.replace(/\s+/g, " ").slice(0, 80);
        continue;
      }
      parsedAny = true;
      if (parsed.type === "open") {
        runtime.activePeriod = parsed.period;
      } else {
        runtime.activePeriod = String((Number(parsed.result.period) || 0) + 1);
        for (const plan of enabledPlans) {
          const state = runtime.plans[plan.id] ?? defaultPlanRuntime();
          runtime.plans[plan.id] = state;
          settlePlanResult(plan, state, runtime, parsed.result);
        }
        scheduleCanadaAutoBet(session, parsed.result.period);
      }
    }
  } catch (err) {
    logger.warn({ userId, err }, "[canada] loop failed");
    if (runtime.lastAlert?.id !== "canada_channel_error") {
      const plan = enabledPlans[0]!;
      const msg = err instanceof Error ? err.message : String(err);
      runtime.lastAlert = {
        id: "canada_channel_error",
        planId: plan.id,
        planName: plan.name,
        message: `读取开奖频道 @pc28 失败：${msg.slice(0, 120)}`,
        at: Date.now(),
        level: "warn",
        voice: false,
      };
      changed = true;
    }
  }
  if (runtime.lastChannelMsgId !== prevMsgId && !parsedAny && runtime.lastAlert?.id !== "canada_parse_failed") {
    const plan = enabledPlans[0]!;
    runtime.lastAlert = {
      id: "canada_parse_failed",
      planId: plan.id,
      planName: plan.name,
      message: `已拉取到开奖频道消息，但格式未识别。示例：${lastUnparsed || "(无文字)"}。需要调整解析规则。`,
      at: Date.now(),
      level: "warn",
      voice: false,
    };
    changed = true;
  }
  if (runtime.lastChannelMsgId !== prevMsgId) changed = true;
  if (runtime.activePeriod !== prevActive) changed = true;
  if (changed) {
    runtime.updatedAt = Date.now();
    saveRuntime(userId, runtime);
  }
}

function clearCanadaBetDelayTimer(userId: number): void {
  const timer = canadaBetDelayTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    canadaBetDelayTimers.delete(userId);
  }
}

function scheduleCanadaAutoBet(session: TgSession, settledPeriod: string): void {
  clearCanadaBetDelayTimer(session.userId);
  canadaBetDelayTimers.set(session.userId, setTimeout(() => {
    canadaBetDelayTimers.delete(session.userId);
    void (async () => {
      const config = loadConfig(session.userId);
      const runtime = loadRuntime(session.userId, config);
      const nextPeriod = String((Number(settledPeriod) || 0) + 1);
      const targetPeriod = runtime.activePeriod ?? nextPeriod;
      runtime.activePeriod = targetPeriod;
      for (const plan of config.plans.filter(plan => plan.enabled)) {
        const state = runtime.plans[plan.id] ?? defaultPlanRuntime();
        runtime.plans[plan.id] = state;
        await triggerPlanForPeriod(session, session.userId, plan, state, runtime, targetPeriod);
      }
      runtime.updatedAt = Date.now();
      saveRuntime(session.userId, runtime);
    })();
  }, 80_000));
}

function startCanadaLoop(): void {
  setInterval(() => {
    for (const session of tgSessions.values()) {
      if (canadaLoopInFlight.has(session.userId)) continue;
      canadaLoopInFlight.add(session.userId);
      void processUserCanada(session).finally(() => canadaLoopInFlight.delete(session.userId));
    }
  }, 3000);
}

startCanadaLoop();

router.get("/canada/config", requireCard, (req, res) => {
  const userId = req.user!.userId;
  res.json(loadConfig(userId));
});

router.post("/canada/config", requireCard, (req, res) => {
  const userId = req.user!.userId;
  const next = normalizeConfig(req.body as Partial<CanadaConfig>);
  saveConfig(userId, next);
  res.json({ ok: true, config: next });
});

router.get("/canada/runtime", requireCard, (req, res) => {
  const userId = req.user!.userId;
  const config = loadConfig(userId);
  const runtime = loadRuntime(userId, config);
  res.json({ runtime });
});

router.post("/canada/test-alert", requireCard, (req, res) => {
  const userId = req.user!.userId;
  const config = loadConfig(userId);
  const runtime = loadRuntime(userId, config);
  const firstPlan = config.plans.find(plan => plan.enabled) ?? config.plans[0] ?? defaultPlan(0);
  const { message } = req.body as { message?: string };
  runtime.lastAlert = makeAlert(
    firstPlan,
    typeof message === "string" && message.trim()
      ? message.trim().slice(0, 120)
      : "加拿大提醒测试：已触发网页语音提醒",
    "info",
  );
  saveRuntime(userId, runtime);
  res.json({
    ok: true,
    message: runtime.lastAlert.message,
    at: Date.now(),
  });
});

export default router;

