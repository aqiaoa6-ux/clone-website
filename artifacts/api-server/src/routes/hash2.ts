import { Router } from "express";
import fs from "fs";
import path from "path";
import { requireCard } from "../middleware/requireAuth";

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
}

interface Hash2Config {
  plans: Hash2Plan[];
  updatedAt: number;
}

const HASH2_MAX_PLANS = 5;
const HASH2_MAX_HANDS = 60;
const HASH2_DEFAULT_LEVELS = Array.from({ length: HASH2_MAX_HANDS }, (_, i) => i + 1);
const HASH2_ALLOWED_BETS = new Set([
  "big", "small", "odd", "even",
  "big-odd", "big-even", "small-odd", "small-even",
  "extreme-big", "extreme-small", "leopard", "pair", "straight",
  ...Array.from({ length: 28 }, (_, i) => `num:${i}`),
]);

function dataDir(): string {
  const dir = process.env.DATA_DIR ?? process.cwd();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
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
    handCount: 1,
    amountLevels: [...HASH2_DEFAULT_LEVELS],
    stopLoss: 0,
    targetProfit: 0,
    zeroAmountRuns: true,
    format: "amount_first",
    webAlertEnabled: true,
    voiceAlertEnabled: true,
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
    format: input?.format === "target_first" ? "target_first" : "amount_first",
    webAlertEnabled: input?.webAlertEnabled !== undefined ? !!input.webAlertEnabled : fallback.webAlertEnabled,
    voiceAlertEnabled: input?.voiceAlertEnabled !== undefined ? !!input.voiceAlertEnabled : fallback.voiceAlertEnabled,
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

router.post("/hash2/test-alert", requireCard, (req, res) => {
  const { message } = req.body as { message?: string };
  res.json({
    ok: true,
    message: typeof message === "string" && message.trim()
      ? message.trim().slice(0, 120)
      : "哈希2提醒测试：已触发网页语音提醒",
    at: Date.now(),
  });
});

export default router;
