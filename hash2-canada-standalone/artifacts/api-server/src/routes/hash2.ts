import { Router } from "express";
import { Api } from "telegram";
import fs from "fs";
import os from "os";
import path from "path";
import { requireCard } from "../middleware/requireAuth";
import { sendAlertEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { tgSessions, type TgSession } from "./telegram";

const router = Router();

type Hash2Format = "amount_first" | "target_first";

interface Hash2Plan {
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
  format: Hash2Format;
  webAlertEnabled: boolean;
  voiceAlertEnabled: boolean;
  basicOdds: Record<string, number>;
  comboOdds: Record<string, number>;
  numberOdds: Record<string, number>;
  specialOdds: Record<string, number>;
}

interface Hash2Config {
  plans: Hash2Plan[];
  updatedAt: number;
}

type Hash2AlertLevel = "info" | "warn" | "success" | "error";

interface Hash2PlanRuntime {
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
  lastRiskNotified?: string;
  updatedAt: number;
}

interface Hash2Alert {
  id: string;
  planId: string;
  planName: string;
  message: string;
  at: number;
  level: Hash2AlertLevel;
  voice: boolean;
}

interface Hash2Runtime {
  plans: Record<string, Hash2PlanRuntime>;
  lastChannelMsgId: number;
  activePeriod: string | null;
  lastAlert?: Hash2Alert;
  updatedAt: number;
}

interface ParsedHash2Result {
  period: string;
  parts?: [number, number, number];
  value: number;
  label: string;
}

const HASH2_MAX_PLANS = 6;
const HASH2_MAX_HANDS = 60;
const HASH2_DEFAULT_LEVELS = Array.from({ length: HASH2_MAX_HANDS }, (_, i) => i + 1);
const STOPLOSS_NEXT_PLAN_ID: Record<string, string> = {
  "plan-1": "plan-2",
  "plan-2": "plan-3",
};
const STOPLOSS_PREV_PLAN_ID: Record<string, string> = {
  "plan-2": "plan-1",
  "plan-3": "plan-2",
};
const HASH2_RESULT_CHANNEL = "hx28kjw";
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
const hash2LoopInFlight = new Set<number>();
const hash2BetDelayTimers = new Map<number, ReturnType<typeof setTimeout>>();
let cachedDataDir: string | null = null;

function tryEnsureWritableDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    fs.writeFileSync(probe, "1", "utf-8");
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    logger.warn({ dir, err }, "[hash2] data dir not writable");
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

function hash2File(userId: number): string {
  return path.join(dataDir(), `.hash2-${userId}.json`);
}

function defaultPlan(index: number): Hash2Plan {
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

function defaultConfig(): Hash2Config {
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

function normalizePlan(input: Partial<Hash2Plan> | undefined, index: number): Hash2Plan {
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

function normalizeConfig(input: Partial<Hash2Config> | undefined): Hash2Config {
  const plans = Array.from({ length: HASH2_MAX_PLANS }, (_, i) => normalizePlan(input?.plans?.[i], i));
  return {
    plans,
    updatedAt: Date.now(),
  };
}

function loadConfig(userId: number): Hash2Config {
  try {
    const file = hash2File(userId);
    if (!fs.existsSync(file)) return defaultConfig();
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<Hash2Config>;
    return normalizeConfig(raw);
  } catch {
    return defaultConfig();
  }
}

function saveConfig(userId: number, config: Hash2Config): void {
  fs.writeFileSync(hash2File(userId), JSON.stringify(config, null, 2), "utf-8");
}

function runtimeFile(userId: number): string {
  return path.join(dataDir(), `.hash2-runtime-${userId}.json`);
}

function defaultPlanRuntime(): Hash2PlanRuntime {
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

function normalizeRuntime(input: Partial<Hash2Runtime> | undefined, config: Hash2Config): Hash2Runtime {
  const plans: Record<string, Hash2PlanRuntime> = {};
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

function loadRuntime(userId: number, config: Hash2Config): Hash2Runtime {
  try {
    const file = runtimeFile(userId);
    if (!fs.existsSync(file)) return normalizeRuntime(undefined, config);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<Hash2Runtime>;
    return normalizeRuntime(raw, config);
  } catch {
    return normalizeRuntime(undefined, config);
  }
}

function saveRuntime(userId: number, runtime: Hash2Runtime): void {
  fs.writeFileSync(runtimeFile(userId), JSON.stringify(runtime, null, 2), "utf-8");
}

function makeAlert(plan: Hash2Plan, message: string, level: Hash2AlertLevel): Hash2Alert {
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

function planLevelCount(plan: Hash2Plan): number {
  let lastConfiguredLevel = 0;
  for (let i = 0; i < Math.min(plan.amountLevels.length, HASH2_MAX_HANDS); i++) {
    const amount = Number(plan.amountLevels[i] ?? 0);
    if (Number.isFinite(amount) && amount > 0) lastConfiguredLevel = i + 1;
  }
  return Math.min(Math.max(Math.max(plan.handCount, lastConfiguredLevel), 1), HASH2_MAX_HANDS);
}

function normalizePlanLevelState(
  plan: Hash2Plan,
  existingLevels: Record<string, number> | undefined,
  existingPendingAmounts: Record<string, number> | undefined,
  legacyLevel: number,
  legacyPendingAmount: number,
): Pick<Hash2PlanRuntime, "betLevels" | "pendingAmounts" | "currentLevel" | "pendingAmount"> {
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

function levelStakeAmount(plan: Hash2Plan, level: number): number {
  const levelAmount = plan.amountLevels[level] ?? plan.baseAmount;
  if (Number.isFinite(levelAmount)) return Math.max(0, levelAmount);
  return Math.max(0, plan.baseAmount);
}

function stakeAmountForBet(plan: Hash2Plan, runtime: Hash2PlanRuntime, key: string): number {
  return levelStakeAmount(plan, runtime.currentLevel ?? 0);
}

function planRiskReason(plan: Hash2Plan, runtime: Hash2PlanRuntime): string | undefined {
  if (plan.stopLoss > 0 && runtime.sessionPnl <= -plan.stopLoss) {
    return `已达止损 ${plan.stopLoss}`;
  }
  if (plan.targetProfit > 0 && runtime.sessionPnl >= plan.targetProfit) {
    return `已达止盈 ${plan.targetProfit}`;
  }
  return undefined;
}

function autoEnableNextPlanOnStopLoss(
  userId: number,
  config: Hash2Config,
  runtime: Hash2Runtime,
  sourcePlan: Hash2Plan,
  riskReason: string,
): boolean {
  if (!riskReason.includes("止损")) return false;
  const nextPlanId = STOPLOSS_NEXT_PLAN_ID[sourcePlan.id];
  if (!nextPlanId) return false;
  const nextPlan = config.plans.find(plan => plan.id === nextPlanId);
  if (!nextPlan || nextPlan.enabled) return false;
  nextPlan.enabled = true;
  config.updatedAt = Date.now();
  runtime.updatedAt = Date.now();
  runtime.lastAlert = makeAlert(
    nextPlan,
    `${sourcePlan.name} ${riskReason}，已自动开启${nextPlan.name}`,
    "warn",
  );
  saveConfig(userId, config);
  logger.info({ userId, sourcePlan: sourcePlan.id, nextPlan: nextPlan.id }, "[hash2] auto enabled next plan after stop loss");
  return true;
}

function resetPlanRuntimeForRestart(plan: Hash2Plan, state: Hash2PlanRuntime): void {
  const levelState = normalizePlanLevelState(plan, {}, {}, 0, 0);
  state.currentLevel = 0;
  state.betLevels = levelState.betLevels;
  state.pendingAmounts = levelState.pendingAmounts;
  state.pendingAmount = 0;
  state.sessionPnl = 0;
  state.totalRounds = 0;
  state.wins = 0;
  state.losses = 0;
  state.pendingPeriod = null;
  state.lastSentPeriod = null;
  state.lastSettledPeriod = null;
  state.blockedReason = undefined;
  state.lastHit = undefined;
  state.lastRiskNotified = undefined;
  state.lastMessage = "";
  state.updatedAt = Date.now();
}

function autoReturnToPlanOneOnTakeProfit(
  userId: number,
  config: Hash2Config,
  runtime: Hash2Runtime,
  sourcePlan: Hash2Plan,
  riskReason: string,
): boolean {
  if (!riskReason.includes("止盈")) return false;
  if (sourcePlan.id !== "plan-2" && sourcePlan.id !== "plan-3") return false;
  const planOne = config.plans.find(plan => plan.id === "plan-1");
  const planOneRuntime = runtime.plans["plan-1"];
  const planTwo = config.plans.find(plan => plan.id === "plan-2");
  const planThree = config.plans.find(plan => plan.id === "plan-3");
  const planTwoRuntime = runtime.plans["plan-2"];
  const planThreeRuntime = runtime.plans["plan-3"];
  if (!planOne || !planOneRuntime || !planTwo || !planTwoRuntime || !planThree || !planThreeRuntime) return false;
  planOne.enabled = true;
  resetPlanRuntimeForRestart(planOne, planOneRuntime);
  planTwo.enabled = false;
  planThree.enabled = false;
  resetPlanRuntimeForRestart(planTwo, planTwoRuntime);
  resetPlanRuntimeForRestart(planThree, planThreeRuntime);
  config.updatedAt = Date.now();
  runtime.updatedAt = Date.now();
  runtime.lastAlert = makeAlert(planOne, `${sourcePlan.name} ${riskReason}，已回到方案1第一手`, "success");
  saveConfig(userId, config);
  logger.info({ userId, sourcePlan: sourcePlan.id, targetPlan: planOne.id }, "[hash2] returned to plan-1 after take profit");
  return true;
}

function canRunAutoChainedPlan(plan: Hash2Plan, runtime: Hash2Runtime): boolean {
  const prevPlanId = STOPLOSS_PREV_PLAN_ID[plan.id];
  if (!prevPlanId) return true;
  const blockedReason = runtime.plans[prevPlanId]?.blockedReason ?? "";
  return blockedReason.includes("止损");
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const fixed = Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2);
  return fixed;
}

async function sendRiskAlert(session: TgSession, userId: number, plan: Hash2Plan, state: Hash2PlanRuntime, riskReason: string, period: string, source: "trigger" | "settle"): Promise<void> {
  const pnl = fmtMoney(state.sessionPnl);
  const title = `【风控提醒】哈希2 ${plan.name}`;
  const text = `${title}\n${riskReason}\n当前盈亏：${pnl}\n期号：${period}\n来源：${source}`;
  const targetId = session.alertGroupId ?? session.watchGroupId;
  if (targetId) {
    try {
      await session.client.sendMessage(targetId, { message: text });
    } catch (err) {
      logger.warn({ userId, err }, "[hash2] risk tg alert failed");
    }
  }
  try {
    await sendAlertEmail(`风控提醒 哈希2 ${plan.name} ${riskReason}`, `userId=${userId}\n${text}`);
  } catch (err) {
    logger.warn({ userId, err }, "[hash2] risk email alert failed");
  }
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

function buildPlanMessage(plan: Hash2Plan, entries: Array<{ key: string; amount: number }>): string {
  const forceTargetFirst = entries.some(entry => entry.key.startsWith("num:"));
  const parts = entries.map(({ key, amount }) => {
    const label = betKeyLabel(key);
    const isNumberBet = key.startsWith("num:");
    const targetFirst = forceTargetFirst || plan.format === "target_first";
    if (isNumberBet) {
      return targetFirst ? `${label}/${formatStake(amount)}` : `${formatStake(amount)}/${label}`;
    }
    return targetFirst ? `${label}${formatStake(amount)}` : `${formatStake(amount)}${label}`;
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

function evaluateBetKey(key: string, result: ParsedHash2Result): boolean {
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

function payoutOdds(key: string, plan: Hash2Plan): number {
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

function parseChannelText(text: string): { type: "open"; period: string } | { type: "result"; result: ParsedHash2Result } | null {
  const openMatch = text.match(/第\s*(\d{4,})\s*期\s*开始/);
  if (openMatch) {
    return { type: "open", period: openMatch[1]! };
  }
  const full = text.match(/(\d{4,})期\s*(\d+)\+(\d+)\+(\d+)=(\d{1,2})\s*(大单|大双|小单|小双)/);
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

async function triggerPlanForPeriod(session: TgSession, userId: number, plan: Hash2Plan, state: Hash2PlanRuntime, runtime: Hash2Runtime, period: string): Promise<void> {
  if (!plan.enabled || state.lastSentPeriod === period) return;
  const config = loadConfig(userId);
  if (!canRunAutoChainedPlan(plan, runtime)) return;
  Object.assign(
    state,
    normalizePlanLevelState(plan, state.betLevels, state.pendingAmounts, state.currentLevel, state.pendingAmount),
  );
  const riskReason = planRiskReason(plan, state);
  if (riskReason) {
    state.blockedReason = riskReason;
    state.lastSentPeriod = period;
    const autoEnabledNextPlan = autoEnableNextPlanOnStopLoss(userId, config, runtime, plan, riskReason);
    const autoReturnedPlanOne = autoReturnToPlanOneOnTakeProfit(userId, config, runtime, plan, riskReason);
    if (state.lastRiskNotified !== riskReason) {
      state.lastRiskNotified = riskReason;
      state.updatedAt = Date.now();
      await sendRiskAlert(session, userId, plan, state, riskReason, period, "trigger");
    }
    if (plan.webAlertEnabled) {
      runtime.lastAlert = makeAlert(
        plan,
        autoReturnedPlanOne
          ? `${plan.name} ${riskReason}，已回到方案1第一手`
          : autoEnabledNextPlan
            ? `${plan.name} ${riskReason}，已自动开启${config.plans.find(item => item.id === STOPLOSS_NEXT_PLAN_ID[plan.id])?.name ?? "下一方案"}`
            : `${plan.name} ${riskReason}`,
        riskReason.includes("止损") ? "error" : "success",
      );
    }
    return;
  }
  state.lastRiskNotified = undefined;
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
    logger.info({ userId, plan: plan.name, period, message }, "[hash2] plan sent");
  } catch (err) {
    state.blockedReason = err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80);
    if (plan.webAlertEnabled) runtime.lastAlert = makeAlert(plan, `${plan.name} 发送失败：${state.blockedReason}`, "error");
  }
}

async function settlePlanResult(session: TgSession, userId: number, plan: Hash2Plan, state: Hash2PlanRuntime, runtime: Hash2Runtime, result: ParsedHash2Result): Promise<void> {
  if (!plan.enabled) return;
  if (state.pendingPeriod !== result.period || state.lastSettledPeriod === result.period) return;
  const config = loadConfig(userId);

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
    const autoEnabledNextPlan = autoEnableNextPlanOnStopLoss(userId, config, runtime, plan, riskReason);
    const autoReturnedPlanOne = autoReturnToPlanOneOnTakeProfit(userId, config, runtime, plan, riskReason);
    if (state.lastRiskNotified !== riskReason) {
      state.lastRiskNotified = riskReason;
      await sendRiskAlert(session, userId, plan, state, riskReason, result.period, "settle");
    }
    if (plan.webAlertEnabled) {
      runtime.lastAlert = makeAlert(
        plan,
        autoReturnedPlanOne
          ? `${plan.name} ${riskReason}，已回到方案1第一手`
          : autoEnabledNextPlan
            ? `${plan.name} ${riskReason}，已自动开启${config.plans.find(item => item.id === STOPLOSS_NEXT_PLAN_ID[plan.id])?.name ?? "下一方案"}`
            : `${plan.name} ${riskReason}`,
        riskReason.includes("止损") ? "error" : "success",
      );
    }
  } else {
    state.blockedReason = undefined;
    state.lastRiskNotified = undefined;
  }
}

async function processUserHash2(session: TgSession): Promise<void> {
  const userId = session.userId;
  const config = loadConfig(userId);
  const enabledPlans = config.plans.filter(plan => plan.enabled);
  if (enabledPlans.length === 0) return;
  const runtime = loadRuntime(userId, config);
  const channel = HASH2_RESULT_CHANNEL as Parameters<typeof session.client.getMessages>[0];
  let changed = false;
  const prevMsgId = runtime.lastChannelMsgId;
  const prevActive = runtime.activePeriod;
  try {
    const msgs = await session.client.getMessages(channel, {
      limit: runtime.lastChannelMsgId > 0 ? 20 : 10,
      ...(runtime.lastChannelMsgId > 0 ? { minId: runtime.lastChannelMsgId } : {}),
    }) as Api.Message[];
    if (!msgs.length) {
      if (runtime.lastChannelMsgId === 0 && runtime.lastAlert?.id !== "hash2_channel_empty") {
        const plan = enabledPlans[0]!;
        runtime.lastAlert = {
          id: "hash2_channel_empty",
          planId: plan.id,
          planName: plan.name,
          message: "未读取到开奖频道 @hx28kjw 的消息：请用当前 TG 账号先加入频道 @hx28kjw（加入后等下一期开奖即可）。",
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
      if (!parsed) continue;
      if (parsed.type === "open") {
        runtime.activePeriod = parsed.period;
      } else {
        runtime.activePeriod = String((Number(parsed.result.period) || 0) + 1);
        for (const plan of enabledPlans) {
          const state = runtime.plans[plan.id] ?? defaultPlanRuntime();
          runtime.plans[plan.id] = state;
          await settlePlanResult(session, userId, plan, state, runtime, parsed.result);
        }
        scheduleHash2AutoBet(session, parsed.result.period);
      }
    }
  } catch (err) {
    logger.warn({ userId, err }, "[hash2] loop failed");
  }
  if (runtime.lastChannelMsgId !== prevMsgId) changed = true;
  if (runtime.activePeriod !== prevActive) changed = true;
  if (changed) {
    runtime.updatedAt = Date.now();
    saveRuntime(userId, runtime);
  }
}

function clearHash2BetDelayTimer(userId: number): void {
  const timer = hash2BetDelayTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    hash2BetDelayTimers.delete(userId);
  }
}

function scheduleHash2AutoBet(session: TgSession, settledPeriod: string): void {
  clearHash2BetDelayTimer(session.userId);
  hash2BetDelayTimers.set(session.userId, setTimeout(() => {
    hash2BetDelayTimers.delete(session.userId);
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
  }, 50_000));
}

function startHash2Loop(): void {
  setInterval(() => {
    for (const session of tgSessions.values()) {
      if (hash2LoopInFlight.has(session.userId)) continue;
      hash2LoopInFlight.add(session.userId);
      void processUserHash2(session).finally(() => hash2LoopInFlight.delete(session.userId));
    }
  }, 3000);
}

startHash2Loop();

router.get("/hash2/config", requireCard, (req, res) => {
  const userId = req.user!.userId;
  res.json(loadConfig(userId));
});

router.post("/hash2/config", requireCard, (req, res) => {
  const userId = req.user!.userId;
  const next = normalizeConfig(req.body as Partial<Hash2Config>);
  saveConfig(userId, next);
  res.json({ ok: true, config: next });
});

router.get("/hash2/runtime", requireCard, (req, res) => {
  const userId = req.user!.userId;
  const config = loadConfig(userId);
  const runtime = loadRuntime(userId, config);
  res.json({ runtime });
});

router.post("/hash2/reset-runtime", requireCard, (req, res) => {
  const userId = req.user!.userId;
  const planId = String((req.body as { planId?: string } | undefined)?.planId ?? "").trim();
  const config = loadConfig(userId);
  const plan = config.plans.find(item => item.id === planId);
  if (!plan) {
    res.status(400).json({ error: "方案不存在" });
    return;
  }
  const runtime = loadRuntime(userId, config);
  const state = runtime.plans[planId];
  if (!state) {
    res.status(400).json({ error: "方案运行状态不存在" });
    return;
  }
  resetPlanRuntimeForRestart(plan, state);
  runtime.updatedAt = Date.now();
  saveRuntime(userId, runtime);
  res.json({ ok: true, runtime });
});

router.post("/hash2/test-alert", requireCard, (req, res) => {
  const userId = req.user!.userId;
  const config = loadConfig(userId);
  const runtime = loadRuntime(userId, config);
  const firstPlan = config.plans.find(plan => plan.enabled) ?? config.plans[0] ?? defaultPlan(0);
  const { message } = req.body as { message?: string };
  runtime.lastAlert = makeAlert(
    firstPlan,
    typeof message === "string" && message.trim()
      ? message.trim().slice(0, 120)
      : "哈希2提醒测试：已触发网页语音提醒",
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
