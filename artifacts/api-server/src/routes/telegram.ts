import { Router, type Response } from "express";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import fs from "fs";
import path from "path";
import { logger } from "../lib/logger";
import { requireAuth, requireCard } from "../middleware/requireAuth";

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

type BetStrategy = "normal" | "martingale" | "anti-martingale";
type BetOption = "big" | "small" | "odd" | "even" | "big-odd" | "big-even" | "small-odd" | "small-even";
type AlgorithmId = "signal_follow" | "signal_reverse" | "streak_follow" | "cold_pick" | "random" | "ai_trend";

interface BetCfg {
  autoBet: boolean;
  betAmount: number;
  strategy: BetStrategy;
  betMultiplier: number;
  maxConsecutiveLosses: number;
  stopLoss: number;
  targetProfit: number;
  cooldownSeconds: number;
  amountLevels: number[];
  stepBackOnWin: boolean;
  betOptions: BetOption[];
  algorithms: AlgorithmId[];
}

interface GroupInfo {
  id: string;
  title: string;
  type: string;
  membersCount?: number;
}

interface BetRecord {
  id: string;
  groupId: string;
  groupTitle: string;
  messageText: string;
  betContent: string;
  amount: number;
  timestamp: number;
  status: "sent" | "failed" | "won" | "lost";
  period?: number;
  lotteryResult?: string;
  pnl?: number;
  won?: boolean;
}

interface TgSession {
  client: TelegramClient;
  stringSession: StringSession;
  phone: string;
  phoneCodeHash?: string;
  me?: Api.User;
  groups: GroupInfo[];
  watchGroupId?: string;
  cfg: BetCfg;
  // runtime state
  consecutiveLosses: number;
  sessionPnl: number;
  currentBet: number;
  lastBetAt: number;
  currentLevel: number;
  algIndex: number;
  recentResults: string[];
  betPlacedThisCycle: boolean;
  lastBetPeriod?: number;
  // balance
  balance: number;
  todayPnl: number;
  todayResetAt: number;
  balanceSource: "manual" | "kkpay";
  balanceUpdatedAt: number;
  kkpayUsername: string;
  kkpayEntityId?: string;
  // timers
  watchdogTimer?: ReturnType<typeof setInterval>;
  saveTimer?: ReturnType<typeof setInterval>;
  autoNextBetTimer?: ReturnType<typeof setTimeout>;
  lotteryPollTimer?: ReturnType<typeof setInterval>;
  lastSeenLotteryPeriod: number;
}

interface PersistedData {
  sessionString: string;
  phone: string;
  balance: number;
  todayPnl: number;
  todayResetAt: number;
  sessionPnl: number;
  kkpayUsername: string;
  balanceSource: "manual" | "kkpay";
  watchGroupId?: string;
  cfg?: Partial<BetCfg>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DRAW_CYCLE_MS = 210_000;
const BET_BEFORE_DRAW_MS = 80_000;
const SESSION_FILE = path.join(process.cwd(), ".tg-session.json");

const DEFAULT_CFG: BetCfg = {
  autoBet: false,
  betAmount: 100,
  strategy: "normal",
  betMultiplier: 2,
  maxConsecutiveLosses: 5,
  stopLoss: 5000,
  targetProfit: 3000,
  cooldownSeconds: 0,
  amountLevels: [100, 200, 300, 500, 1000],
  stepBackOnWin: true,
  betOptions: ["big", "small"],
  algorithms: ["signal_follow"],
};

const BET_OPTION_LABELS: Record<BetOption, string> = {
  big: "大", small: "小", odd: "单", even: "双",
  "big-odd": "大单", "big-even": "大双", "small-odd": "小单", "small-even": "小双",
};

// ─── Module state ─────────────────────────────────────────────────────────────

let tgSession: TgSession | null = null;
const betLog: BetRecord[] = [];
let messageHandler: ((event: NewMessageEvent) => Promise<void>) | null = null;
let messageHandlerBuilder: NewMessage | null = null;
let kkpayHandler: ((event: NewMessageEvent) => Promise<void>) | null = null;
let kkpayHandlerBuilder: NewMessage | null = null;
let lotteryHistoryCache: string[] = [];
const sseClients = new Set<Response>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCredentials() {
  return {
    apiId: parseInt(process.env["TELEGRAM_API_ID"] ?? "0", 10),
    apiHash: process.env["TELEGRAM_API_HASH"] ?? "",
  };
}

function makeClientOptions() {
  return {
    connectionRetries: 1000,
    autoReconnect: true,
    retryDelay: 2000,
    floodSleepThreshold: 60,
    deviceModel: "iPhone 14",
    systemVersion: "iOS 17.0",
    appVersion: "9.7.0",
  };
}

function todayMidnight(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function pushEvent(type: string, payload: Record<string, unknown>): void {
  if (sseClients.size === 0) return;
  const data = JSON.stringify({ type, ...payload });
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
}

// ─── Session persistence ──────────────────────────────────────────────────────

function saveSession(): void {
  if (!tgSession) return;
  try {
    const data: PersistedData = {
      sessionString: tgSession.stringSession.save(),
      phone: tgSession.phone,
      balance: tgSession.balance,
      todayPnl: tgSession.todayPnl,
      todayResetAt: tgSession.todayResetAt,
      sessionPnl: tgSession.sessionPnl,
      kkpayUsername: tgSession.kkpayUsername,
      balanceSource: tgSession.balanceSource,
      watchGroupId: tgSession.watchGroupId,
      cfg: tgSession.cfg,
    };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch { /* ignore */ }
}

async function fetchGroups(client: TelegramClient): Promise<GroupInfo[]> {
  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    return dialogs
      .filter((d) => d.isGroup || d.isChannel)
      .map((d) => ({
        id: String(d.id),
        title: d.title ?? "Unknown",
        type: d.isChannel ? "channel" : "group",
        membersCount: (d.entity as Api.Chat)?.participantsCount ?? undefined,
      }));
  } catch {
    return [];
  }
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────

function stopAllTimers(session: TgSession): void {
  if (session.watchdogTimer) { clearInterval(session.watchdogTimer); session.watchdogTimer = undefined; }
  if (session.saveTimer) { clearInterval(session.saveTimer); session.saveTimer = undefined; }
  if (session.autoNextBetTimer) { clearTimeout(session.autoNextBetTimer); session.autoNextBetTimer = undefined; }
  if (session.lotteryPollTimer) { clearInterval(session.lotteryPollTimer); session.lotteryPollTimer = undefined; }
}

function startWatchdog(session: TgSession): void {
  stopAllTimers(session);

  session.saveTimer = setInterval(() => {
    if (tgSession !== session) { clearInterval(session.saveTimer); return; }
    saveSession();
  }, 5 * 60 * 1000);

  session.watchdogTimer = setInterval(() => {
    if (tgSession !== session) { clearInterval(session.watchdogTimer); return; }
    void (async () => {
      try {
        await session.client.getMe();
      } catch {
        try {
          await session.client.connect();
          if (session.watchGroupId) startGroupListener(session);
          await startKkpayListener(session);
          saveSession();
          pushEvent("session:reconnected", { at: Date.now() });
        } catch { /* retry next cycle */ }
      }
    })();
  }, 15 * 1000);
}

// ─── Restore session on boot ──────────────────────────────────────────────────

async function restoreSession(): Promise<void> {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    const data = JSON.parse(raw) as PersistedData;
    if (!data.sessionString) return;

    const { apiId, apiHash } = getCredentials();
    if (!apiId || !apiHash) return;

    const stringSession = new StringSession(data.sessionString);
    const client = new TelegramClient(stringSession, apiId, apiHash, makeClientOptions());
    await client.connect();
    const me = (await client.getMe()) as Api.User;
    if (!me?.id) return;

    tgSession = {
      client, stringSession,
      phone: data.phone ?? "",
      groups: await fetchGroups(client),
      cfg: data.cfg ? { ...DEFAULT_CFG, ...data.cfg, autoBet: false } : { ...DEFAULT_CFG },
      consecutiveLosses: 0,
      sessionPnl: 0,
      currentBet: data.cfg?.betAmount ?? DEFAULT_CFG.betAmount,
      lastBetAt: 0,
      currentLevel: 0,
      algIndex: 0,
      betPlacedThisCycle: false,
      lastSeenLotteryPeriod: 0,
      recentResults: [],
      balance: data.balance ?? 1000000,
      todayPnl: data.todayPnl ?? 0,
      todayResetAt: data.todayResetAt ?? todayMidnight(),
      kkpayUsername: data.kkpayUsername ?? "kkpay",
      kkpayEntityId: undefined,
      balanceSource: data.balanceSource ?? "manual",
      balanceUpdatedAt: 0,
      me,
      watchGroupId: data.watchGroupId,
    };

    if (tgSession.watchGroupId) startGroupListener(tgSession);
    startKkpayListener(tgSession).catch(() => { /* ignore */ });
    startWatchdog(tgSession);
  } catch {
    try { fs.unlinkSync(SESSION_FILE); } catch { /* ok */ }
  }
}

void restoreSession();

// ─── Balance parsing ──────────────────────────────────────────────────────────

function parseBalance(text: string): number | null {
  const patterns = [
    /当前余额[：:\s]*[¥￥]?\s*([\d,]+\.?\d*)/i,
    /(?:可用|账[户号])?余额[：:\s]*[¥￥]?\s*([\d,]+\.?\d*)/i,
    /balance[：:\s]*[¥￥]?\s*([\d,]+\.?\d*)/i,
    /💰\s*[¥￥]?\s*([\d,]+\.?\d*)/,
    /剩余[：:\s]*[¥￥]?\s*([\d,]+\.?\d*)/i,
    /总资产[：:\s]*[¥￥]?\s*([\d,]+\.?\d*)/i,
    /钱包余额[：:\s]*[¥￥]?\s*([\d,]+\.?\d*)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (!isNaN(val) && val >= 0) return val;
    }
  }
  return null;
}

function updateBalance(session: TgSession, text: string): void {
  const bal = parseBalance(text);
  if (bal === null) return;
  session.balance = bal;
  session.balanceSource = "kkpay";
  session.balanceUpdatedAt = Date.now();
  pushEvent("balance:update", {
    balance: bal,
    balanceSource: "kkpay",
    balanceUpdatedAt: session.balanceUpdatedAt,
  });
}

// ─── Bet settlement ───────────────────────────────────────────────────────────

function computeNextBet(session: TgSession, won: boolean): number {
  const { amountLevels, stepBackOnWin, betAmount, strategy, betMultiplier } = session.cfg;
  if (amountLevels.length > 1) {
    let lvl = session.currentLevel;
    lvl = won ? (stepBackOnWin ? Math.max(0, lvl - 1) : lvl) : Math.min(amountLevels.length - 1, lvl + 1);
    session.currentLevel = lvl;
    return amountLevels[lvl]!;
  }
  if (strategy === "normal") return betAmount;
  if (strategy === "martingale") return won ? betAmount : Math.round(session.currentBet * betMultiplier);
  return won ? Math.round(session.currentBet * betMultiplier) : betAmount;
}

function checkRisk(session: TgSession): { ok: boolean; reason?: string } {
  const { stopLoss, targetProfit, maxConsecutiveLosses, cooldownSeconds } = session.cfg;
  if (maxConsecutiveLosses > 0 && session.consecutiveLosses >= maxConsecutiveLosses)
    return { ok: false, reason: `连亏${session.consecutiveLosses}局，已达上限${maxConsecutiveLosses}局` };
  if (stopLoss > 0 && session.sessionPnl <= -stopLoss)
    return { ok: false, reason: `亏损 ¥${Math.abs(session.sessionPnl).toFixed(0)} 已达止损 ¥${stopLoss}` };
  if (targetProfit > 0 && session.sessionPnl >= targetProfit)
    return { ok: false, reason: `盈利 ¥${session.sessionPnl.toFixed(0)} 已达止盈 ¥${targetProfit}` };
  if (cooldownSeconds > 0 && session.lastBetAt > 0) {
    const elapsed = (Date.now() - session.lastBetAt) / 1000;
    if (elapsed < cooldownSeconds)
      return { ok: false, reason: `冷却中 (${Math.ceil(cooldownSeconds - elapsed)}s)` };
  }
  return { ok: true };
}

function settleBet(session: TgSession, opts: { won: boolean; pnl?: number; result?: string; betId?: string; period?: number }): void {
  const { won, pnl, result, betId, period } = opts;

  if (pnl !== undefined) {
    session.sessionPnl += pnl;
    session.balance += pnl;
    const midnight = todayMidnight();
    if (session.todayResetAt < midnight) { session.todayPnl = 0; session.todayResetAt = midnight; }
    session.todayPnl += pnl;
  }

  const record = betId ? betLog.find(b => b.id === betId) : betLog.find(b => b.status === "sent");
  if (record) {
    record.won = won;
    record.status = won ? "won" : "lost";
    if (pnl !== undefined) record.pnl = pnl;
    if (result) record.lotteryResult = result;
    if (period && !record.period) record.period = period;
  }

  if (result) {
    session.recentResults.push(result);
    if (session.recentResults.length > 30) session.recentResults.shift();
  }

  session.consecutiveLosses = won ? 0 : session.consecutiveLosses + 1;
  session.currentBet = computeNextBet(session, won);

  if (record) {
    const settled = betLog.filter(b => b.won !== undefined);
    const wins = settled.filter(b => b.won === true).length;
    let streak = 0, maxS = 0;
    for (const b of [...betLog].reverse()) {
      if (b.won === true) { streak++; if (streak > maxS) maxS = streak; }
      else if (b.won === false) streak = 0;
    }
    pushEvent("bet:result", {
      bet: record,
      balance: session.balance,
      todayPnl: session.todayPnl,
      sessionPnl: session.sessionPnl,
      consecutiveLosses: session.consecutiveLosses,
      currentBet: session.currentBet,
      totalBets: betLog.filter(b => b.status !== "failed").length,
      settled: settled.length,
      wins, maxStreak: maxS,
      winRate: settled.length > 0 ? ((wins / settled.length) * 100).toFixed(2) : "0.00",
    });
  }
}

// ─── Algorithm / direction decision ──────────────────────────────────────────

function parseBetLabel(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("大单")) return "大单";
  if (lower.includes("大双")) return "大双";
  if (lower.includes("小单")) return "小单";
  if (lower.includes("小双")) return "小双";
  if (lower.includes("大")) return "大";
  if (lower.includes("小")) return "小";
  if (lower.includes("单")) return "单";
  if (lower.includes("双")) return "双";
  return null;
}

function mapR3ToEnabled(r3: string, enabled: string[]): string | null {
  if (enabled.includes(r3)) return r3;
  if (enabled.includes("大") && r3.startsWith("大")) return "大";
  if (enabled.includes("小") && r3.startsWith("小")) return "小";
  if (enabled.includes("单") && r3.endsWith("单")) return "单";
  if (enabled.includes("双") && r3.endsWith("双")) return "双";
  return null;
}

function freqPick(items: string[], labels: string[], sortAsc: boolean): string | null {
  const freq: Record<string, number> = {};
  for (const l of labels) freq[l] = 0;
  for (const r of items) { const m = mapR3ToEnabled(r, labels); if (m) freq[m] = (freq[m] ?? 0) + 1; }
  const sorted = Object.entries(freq).sort((a, b) => sortAsc ? a[1] - b[1] : b[1] - a[1]);
  return sorted[0]?.[0] ?? labels[Math.floor(Math.random() * labels.length)] ?? null;
}

function buildHistory(session: TgSession): string[] {
  return session.recentResults.length >= 3
    ? session.recentResults.slice(-10)
    : [...lotteryHistoryCache.slice(-10), ...session.recentResults];
}

function decideAI(session: TgSession): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length) return null;
  const [optA, optB = optA] = labels;
  const history = [...lotteryHistoryCache, ...session.recentResults]
    .map(r => mapR3ToEnabled(r, labels)).filter((x): x is string => x !== null);
  if (!history.length) return labels[Math.floor(Math.random() * labels.length)] ?? null;
  let votes = 0;
  const last5 = history.slice(-5);
  const streak = last5.reduce((acc, x) => x === last5[last5.length - 1] ? acc + 1 : 0, 0);
  if (streak >= 4) votes += last5[last5.length - 1] === optA ? -3 : 3;
  else if (streak === 3) votes += last5[last5.length - 1] === optA ? -2 : 2;
  else if (streak === 2) votes += last5[last5.length - 1] === optA ? 1 : -1;
  const last15 = history.slice(-15);
  const rA = last15.filter(x => x === optA).length / (last15.length || 1);
  if (rA >= 0.7) votes -= 2;
  else if (rA <= 0.3) votes += 2;
  else votes += rA < 0.5 ? 1 : -1;
  const last6 = history.slice(-6);
  if (last6.length >= 4 && last6.every((x, i) => i === 0 || x !== last6[i - 1]))
    votes += last6[last6.length - 1] === optA ? -1 : 1;
  const last12 = history.slice(-12);
  const ws = last12.reduce((s, x, i) => s + ((i + 1) * (x === optA ? 1 : -1)), 0);
  votes += ws > 0 ? -1 : 1;
  if (votes > 0) return optA;
  if (votes < 0) return optB;
  const last20 = history.slice(-20);
  return last20.filter(x => x === optA).length <= last20.length / 2 ? optA : optB;
}

function decideBet(session: TgSession, signalText: string): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length || !session.cfg.algorithms.length) return null;
  const algoId = session.cfg.algorithms[session.algIndex % session.cfg.algorithms.length];
  session.algIndex++;

  if (algoId === "ai_trend") return decideAI(session);
  if (algoId === "random") return labels[Math.floor(Math.random() * labels.length)] ?? null;

  const history = buildHistory(session);

  if (algoId === "signal_follow") {
    const p = parseBetLabel(signalText);
    if (!p) return null;
    return labels.includes(p) ? p : (labels[0] ?? null);
  }
  if (algoId === "signal_reverse") {
    const p = parseBetLabel(signalText);
    if (!p) return null;
    const opp: Record<string, string> = { 大:"小", 小:"大", 单:"双", 双:"单", 大单:"小双", 大双:"小单", 小单:"大双", 小双:"大单" };
    const rev = opp[p];
    return (rev && labels.includes(rev)) ? rev : (labels[0] ?? null);
  }
  if (algoId === "streak_follow") return freqPick(history, labels, false);
  if (algoId === "cold_pick" || algoId === "signal_reverse") return freqPick(history, labels, true);
  return freqPick(history, labels, true);
}

function decideBetAuto(session: TgSession): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length || !session.cfg.algorithms.length) return null;
  const algoId = session.cfg.algorithms[session.algIndex % session.cfg.algorithms.length];
  session.algIndex++;
  if (algoId === "ai_trend") return decideAI(session);
  if (algoId === "random") return labels[Math.floor(Math.random() * labels.length)] ?? null;
  const history = buildHistory(session);
  const cold = algoId === "cold_pick" || algoId === "signal_reverse";
  return freqPick(history, labels, cold);
}

// ─── Auto-bet engine ──────────────────────────────────────────────────────────

async function placeBet(session: TgSession, direction: string): Promise<void> {
  const targetId = session.watchGroupId!;
  const amount = session.currentBet;
  const groupTitle = session.groups.find(g => g.id === targetId || `-100${g.id}` === targetId)?.title ?? targetId;
  session.betPlacedThisCycle = true;
  try {
    await session.client.sendMessage(targetId, { message: `${direction}${amount}` });
    session.lastBetAt = Date.now();
    betLog.unshift({ id: String(Date.now()), groupId: targetId, groupTitle, messageText: "[自动投注]", betContent: direction, amount, timestamp: Date.now(), status: "sent" });
    if (betLog.length > 200) betLog.pop();
    pushEvent("bet:new", { bet: betLog[0] });
  } catch {
    betLog.unshift({ id: String(Date.now()), groupId: targetId, groupTitle, messageText: "[自动投注]", betContent: direction, amount, timestamp: Date.now(), status: "failed" });
    if (betLog.length > 200) betLog.pop();
    pushEvent("bet:new", { bet: betLog[0] });
  }
}

async function runAutoBet(session: TgSession): Promise<void> {
  if (!session.cfg.autoBet || !session.watchGroupId) return;
  const nowMs = Date.now();
  for (const stale of betLog.filter(b => b.status === "sent" && nowMs - b.timestamp > 240_000)) stale.status = "lost";
  if (betLog.some(b => b.status === "sent")) return;
  if (session.betPlacedThisCycle) return;
  const risk = checkRisk(session);
  if (!risk.ok) return;
  const direction = decideBetAuto(session);
  if (!direction) return;
  await placeBet(session, direction);
}

function scheduleNextBet(session: TgSession, closeTimeMs: number, cycleMs: number): void {
  if (session.autoNextBetTimer) { clearTimeout(session.autoNextBetTimer); session.autoNextBetTimer = undefined; }
  if (!session.cfg.autoBet || !session.watchGroupId) return;

  const timeToClose = closeTimeMs - Date.now();
  const delay = Math.max(5_000,
    timeToClose >= BET_BEFORE_DRAW_MS + 5_000
      ? timeToClose - BET_BEFORE_DRAW_MS
      : timeToClose + cycleMs - BET_BEFORE_DRAW_MS
  );

  logger.info({ delaySec: Math.round(delay / 1000), timeToCloseSec: Math.round(timeToClose / 1000) }, "[bet-timer] scheduled");
  pushEvent("timer:scheduled", { fireAt: Date.now() + delay, delaySec: Math.round(delay / 1000) });

  session.autoNextBetTimer = setTimeout(() => {
    session.autoNextBetTimer = undefined;
    void runAutoBet(session);
  }, delay);
}

// ─── Lottery poller ───────────────────────────────────────────────────────────

type DrawItem = { term: number; r3?: string; sum1?: number; sum2?: number; sum3?: number; result?: number; openTime?: number; closeTime?: number };

async function pollLottery(session: TgSession): Promise<void> {
  try {
    const r = await fetch("http://pc20.net/api/fengpan", {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", "Referer": "http://pc20.net/" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return;
    const data = await r.json() as { message?: { all?: { keno28?: { data?: DrawItem[] } } } };
    const items = data?.message?.all?.keno28?.data ?? [];
    const latest = items[0];
    if (!latest?.term) return;

    const labels = items.map(d => d.r3).filter((x): x is string => !!x).reverse();
    if (labels.length) lotteryHistoryCache = labels.slice(-50);

    if (latest.term <= session.lastSeenLotteryPeriod) return;

    if (latest.r3) {
      const pending = betLog.find(b => b.status === "sent");
      if (pending) {
        const bet = pending.betContent.trim();
        let won = bet === latest.r3;
        if (!won && bet.length === 1) {
          won = (bet === "大" && latest.r3.startsWith("大")) ||
                (bet === "小" && latest.r3.startsWith("小")) ||
                (bet === "单" && latest.r3.endsWith("单")) ||
                (bet === "双" && latest.r3.endsWith("双"));
        }
        settleBet(session, { won, pnl: won ? pending.amount : -pending.amount, result: latest.r3, betId: pending.id, period: latest.term });
      }
    }

    session.lastSeenLotteryPeriod = latest.term;

    const closeMs = latest.closeTime ?? 0;
    const openMs = latest.openTime ?? 0;
    const nowMs = Date.now();
    const cycleMs = (closeMs > openMs && closeMs - openMs < 600000) ? (closeMs - openMs) : DRAW_CYCLE_MS;
    const nextCloseMs = closeMs > nowMs ? closeMs : closeMs + cycleMs;

    pushEvent("draw:new", {
      term: latest.term, r3: latest.r3 ?? "",
      sum1: latest.sum1, sum2: latest.sum2, sum3: latest.sum3,
      result: latest.result, closeTime: closeMs, openTime: openMs,
      nextCloseTime: nextCloseMs,
    });

    session.betPlacedThisCycle = false;
    if (session.cfg.autoBet && session.watchGroupId) {
      const refClose = nextCloseMs > nowMs ? nextCloseMs : nowMs + cycleMs;
      scheduleNextBet(session, refClose, cycleMs);
    }
  } catch { /* network errors ignored */ }
}

function startPoller(session: TgSession): void {
  if (session.lotteryPollTimer) return;
  session.lotteryPollTimer = setInterval(() => { void pollLottery(session); }, 5_000);
}

function stopPoller(session: TgSession): void {
  if (session.lotteryPollTimer) { clearInterval(session.lotteryPollTimer); session.lotteryPollTimer = undefined; }
  if (session.autoNextBetTimer) { clearTimeout(session.autoNextBetTimer); session.autoNextBetTimer = undefined; }
}

// ─── Group message listener ───────────────────────────────────────────────────

function startGroupListener(session: TgSession): void {
  if (!session.watchGroupId) return;
  if (messageHandler && messageHandlerBuilder) {
    try { session.client.removeEventHandler(messageHandler, messageHandlerBuilder); } catch { /* ok */ }
    messageHandler = null; messageHandlerBuilder = null;
  }
  const targetId = session.watchGroupId;

  messageHandler = async (event: NewMessageEvent) => {
    if (!session.cfg.autoBet) return;
    const msg = event.message;
    if (msg.out) return;
    const chatId = String(msg.chatId);
    if (chatId !== targetId && `-100${chatId}` !== targetId) return;
    const senderId = String(msg.senderId ?? "");
    if (session.kkpayEntityId && senderId === session.kkpayEntityId) return;
    const text = msg.message ?? "";
    if (betLog.some(b => b.status === "sent")) return;
    if (session.betPlacedThisCycle) return;
    const periodInMsg = text.match(/第?(\d{6,10})期/)?.at(1);
    const triggerPeriod = periodInMsg ? parseInt(periodInMsg) : undefined;
    if (triggerPeriod && triggerPeriod === session.lastBetPeriod) return;
    const risk = checkRisk(session);
    if (!risk.ok) return;
    const direction = decideBet(session, text);
    if (!direction) return;
    if (session.autoNextBetTimer) { clearTimeout(session.autoNextBetTimer); session.autoNextBetTimer = undefined; }
    session.betPlacedThisCycle = true;
    if (triggerPeriod) session.lastBetPeriod = triggerPeriod;
    const amount = session.currentBet;
    const groupTitle = session.groups.find(g => g.id === targetId || `-100${g.id}` === targetId)?.title ?? targetId;
    void (async () => {
      try {
        await session.client.sendMessage(targetId, { message: `${direction}${amount}` });
        session.lastBetAt = Date.now();
        betLog.unshift({ id: String(Date.now()), groupId: targetId, groupTitle, messageText: text.slice(0, 80), betContent: direction, amount, timestamp: Date.now(), status: "sent", period: triggerPeriod });
        if (betLog.length > 200) betLog.pop();
        pushEvent("bet:new", { bet: betLog[0] });
      } catch {
        betLog.unshift({ id: String(Date.now()), groupId: targetId, groupTitle, messageText: text.slice(0, 80), betContent: direction, amount, timestamp: Date.now(), status: "failed" });
        if (betLog.length > 200) betLog.pop();
      }
    })();
  };

  messageHandlerBuilder = new NewMessage({});
  session.client.addEventHandler(messageHandler, messageHandlerBuilder);
}

// ─── KKPay listener ───────────────────────────────────────────────────────────

async function startKkpayListener(session: TgSession): Promise<void> {
  if (kkpayHandler && kkpayHandlerBuilder) {
    try { session.client.removeEventHandler(kkpayHandler, kkpayHandlerBuilder); } catch { /* ok */ }
    kkpayHandler = null; kkpayHandlerBuilder = null;
  }

  const uname = session.kkpayUsername.replace(/^@/, "");
  try {
    const entity = await session.client.getEntity(uname);
    session.kkpayEntityId = String((entity as unknown as { id: bigint | number }).id);
  } catch { /* entity not found */ }

  kkpayHandler = async (event: NewMessageEvent) => {
    const msg = event.message;
    if (msg.out) return;
    const text = msg.message ?? "";
    if (!text) return;
    const chatId = String(msg.chatId ?? "");
    const senderId = String(msg.senderId ?? "");
    const eid = session.kkpayEntityId;
    const wgid = session.watchGroupId;
    const isFromKkpay = eid ? (senderId === eid || chatId === eid || `-100${chatId}` === eid) : false;
    const inWatchGroup = wgid ? (chatId === wgid || `-100${chatId}` === wgid) : false;
    if (!isFromKkpay && !inWatchGroup) return;

    // Update balance from any KKCOIN message in watch group or from kkpay entity
    if (isFromKkpay || (inWatchGroup && /KKCOIN/i.test(text))) {
      updateBalance(session, text);
    }

    // Win/loss settlement
    const hasWin = /(?<!未)中奖|✅/.test(text);
    const hasLoss = /挂逼|未中|未赢|❌/.test(text);
    const danjineM = text.match(/单金额\s*([+-]?\d[\d,]*(?:\.\d+)?)/);
    let isWin = danjineM ? parseFloat(danjineM[1].replace(/,/g, "")) >= 0 : hasWin;
    let isLoss = danjineM ? parseFloat(danjineM[1].replace(/,/g, "")) < 0 : (hasLoss && !hasWin);
    const hasPeriodRef = /\d{5,}期/.test(text);
    const isKkpayResult = isFromKkpay || (inWatchGroup && hasPeriodRef && (hasWin || hasLoss || danjineM !== null || /KKCOIN/i.test(text)));

    if (isKkpayResult && (isWin || isLoss) && tgSession === session) {
      const sentBet = betLog.find(b => b.status === "sent");
      if (sentBet) {
        const pnlM = text.match(/([+-][\d,]+(?:\.\d+)?)\s*KKCOIN/i) ?? text.match(/KKCOIN\s*([+-][\d,]+(?:\.\d+)?)/i) ?? danjineM;
        const pnl = pnlM ? parseFloat(pnlM[1].replace(/,/g, "")) : undefined;
        if (pnl !== undefined) { isWin = pnl >= 0; isLoss = pnl < 0; }
        const rMatch = text.match(/[大小][单双]|[大小]|[单双]/);
        const periodFromMsg = text.match(/第?(\d{6,10})期/)?.at(1);
        settleBet(session, { won: isWin, pnl, result: rMatch?.[0], betId: sentBet.id, period: periodFromMsg ? parseInt(periodFromMsg) : undefined });
        updateBalance(session, text);
        saveSession();
      }
    }
  };

  kkpayHandlerBuilder = new NewMessage({});
  session.client.addEventHandler(kkpayHandler, kkpayHandlerBuilder);
}

// ─── Stats helper ─────────────────────────────────────────────────────────────

function buildStats() {
  const settled = betLog.filter(b => b.won !== undefined);
  const wins = settled.filter(b => b.won === true).length;
  let maxStreak = 0, cur = 0;
  for (const b of [...betLog].reverse()) {
    if (b.won === true) { cur++; if (cur > maxStreak) maxStreak = cur; }
    else if (b.won === false) cur = 0;
  }
  return {
    totalBets: betLog.filter(b => b.status !== "failed").length,
    settled: settled.length,
    wins,
    maxStreak,
    winRate: settled.length > 0 ? ((wins / settled.length) * 100).toFixed(2) : "0.00",
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Login routes (no card required — user must be authenticated but not yet have a card)
router.post("/tg/send-code", requireAuth, async (req, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ error: "请输入手机号" }); return; }
  const { apiId, apiHash } = getCredentials();
  if (!apiId || !apiHash) { res.status(500).json({ error: "服务端未配置 Telegram API 凭证" }); return; }
  try {
    if (tgSession?.client?.connected) {
      try { await tgSession.client.disconnect(); } catch { /* ok */ }
    }
    const stringSession = new StringSession("");
    const client = new TelegramClient(stringSession, apiId, apiHash, makeClientOptions());
    await client.connect();
    const result = await client.sendCode({ apiId, apiHash }, phone);
    tgSession = {
      client, stringSession, phone,
      phoneCodeHash: result.phoneCodeHash,
      groups: [], cfg: { ...DEFAULT_CFG },
      consecutiveLosses: 0, sessionPnl: 0,
      currentBet: DEFAULT_CFG.betAmount, lastBetAt: 0,
      currentLevel: 0, algIndex: 0,
      betPlacedThisCycle: false, lastSeenLotteryPeriod: 0,
      recentResults: [], balance: 1000000,
      todayPnl: 0, todayResetAt: todayMidnight(),
      kkpayUsername: "kkpay", kkpayEntityId: undefined,
      balanceSource: "manual", balanceUpdatedAt: 0,
    };
    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("PHONE_NUMBER_INVALID")) res.status(400).json({ error: "手机号格式错误（需含国家码，如 +8613800001234）" });
    else res.status(500).json({ error: msg });
  }
});

router.post("/tg/verify-code", requireAuth, async (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ error: "请输入验证码" }); return; }
  if (!tgSession) { res.status(400).json({ error: "请先发送验证码" }); return; }
  const { apiId, apiHash } = getCredentials();
  try {
    const result = await tgSession.client.invoke(new Api.auth.SignIn({
      phoneNumber: tgSession.phone,
      phoneCodeHash: tgSession.phoneCodeHash!,
      phoneCode: code,
    }));
    const me = (result as Api.auth.Authorization).user as Api.User;
    tgSession.me = me;
    tgSession.groups = await fetchGroups(tgSession.client);
    startKkpayListener(tgSession).catch(() => { /* ignore */ });
    saveSession();
    startWatchdog(tgSession);
    res.json({ ok: true, me: { id: me.id, firstName: me.firstName, lastName: me.lastName, username: me.username, phone: me.phone } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SESSION_PASSWORD_NEEDED")) { res.json({ ok: false, needPassword: true }); return; }
    if (msg.includes("PHONE_CODE_INVALID") || msg.includes("CODE_INVALID")) { res.status(400).json({ error: "验证码错误" }); return; }
    if (msg.includes("PHONE_CODE_EXPIRED")) { res.status(400).json({ error: "验证码已过期，请重新获取" }); return; }
    res.status(500).json({ error: msg });
  }
});

router.post("/tg/verify-password", requireAuth, async (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password) { res.status(400).json({ error: "请输入二步验证密码" }); return; }
  if (!tgSession) { res.status(400).json({ error: "会话已失效，请重新登录" }); return; }
  const { apiId, apiHash } = getCredentials();
  try {
    await tgSession.client.signInWithPassword({ apiId, apiHash }, { password: async () => password, onError: async (e: Error) => { throw e; } });
    const me = (await tgSession.client.getMe()) as Api.User;
    tgSession.me = me;
    tgSession.groups = await fetchGroups(tgSession.client);
    startKkpayListener(tgSession).catch(() => { /* ignore */ });
    saveSession();
    startWatchdog(tgSession);
    res.json({ ok: true, me: { id: me.id, firstName: me.firstName, lastName: me.lastName, username: me.username, phone: me.phone } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("PASSWORD_HASH_INVALID")) { res.status(400).json({ error: "二步验证密码错误" }); return; }
    res.status(500).json({ error: msg });
  }
});

router.get("/tg/status", requireAuth, (req, res) => {
  if (!tgSession?.me) { res.json({ connected: false }); return; }
  const midnight = todayMidnight();
  if (tgSession.todayResetAt < midnight) { tgSession.todayPnl = 0; tgSession.todayResetAt = midnight; }
  const stats = buildStats();
  res.json({
    connected: true,
    me: { id: tgSession.me.id, firstName: tgSession.me.firstName, lastName: tgSession.me.lastName, username: tgSession.me.username, phone: tgSession.me.phone },
    watchGroupId: tgSession.watchGroupId,
    watchGroupTitle: (() => { const wgid = tgSession!.watchGroupId; return tgSession!.groups.find(g => g.id === wgid || `-100${g.id}` === wgid)?.title; })(),
    ...tgSession.cfg,
    consecutiveLosses: tgSession.consecutiveLosses,
    sessionPnl: tgSession.sessionPnl,
    currentBet: tgSession.currentBet,
    balance: tgSession.balance,
    todayPnl: tgSession.todayPnl,
    balanceSource: tgSession.balanceSource,
    balanceUpdatedAt: tgSession.balanceUpdatedAt,
    kkpayUsername: tgSession.kkpayUsername,
    kkpayEntityId: tgSession.kkpayEntityId,
    riskBlocked: !checkRisk(tgSession).ok,
    riskReason: checkRisk(tgSession).reason,
    ...stats,
  });
});

router.get("/tg/groups", requireAuth, async (req, res) => {
  if (!tgSession?.client) { res.status(401).json({ error: "未连接 Telegram" }); return; }
  tgSession.groups = await fetchGroups(tgSession.client);
  res.json({ groups: tgSession.groups });
});

router.post("/tg/resolve-group", requireAuth, async (req, res) => {
  if (!tgSession?.client) { res.status(401).json({ error: "未连接 Telegram" }); return; }
  const { link } = req.body as { link?: string };
  if (!link) { res.status(400).json({ error: "请提供群链接" }); return; }
  let uname = link.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").replace(/\?.*$/, "");
  try {
    const entity = await tgSession.client.getEntity(uname);
    const id = String((entity as unknown as { id: bigint | number }).id);
    const title = (entity as { title?: string; firstName?: string }).title ?? (entity as { firstName?: string }).firstName ?? uname;
    res.json({ ok: true, group: { id, title, type: "broadcast" in entity ? "channel" : "group" } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("USERNAME_NOT_OCCUPIED") || msg.includes("Cannot find")) res.status(404).json({ error: "找不到该群" });
    else res.status(500).json({ error: msg });
  }
});

router.post("/tg/set-group", requireAuth, (req, res) => {
  if (!tgSession) { res.status(401).json({ error: "未连接 Telegram" }); return; }
  const { groupId } = req.body as { groupId?: string };
  if (groupId !== undefined) tgSession.watchGroupId = groupId;
  if (tgSession.watchGroupId) startGroupListener(tgSession);
  saveSession();
  res.json({ ok: true });
});

router.get("/tg/config", requireAuth, (_req, res) => {
  if (!tgSession) { res.json({ cfg: DEFAULT_CFG }); return; }
  res.json({ cfg: tgSession.cfg, consecutiveLosses: tgSession.consecutiveLosses, sessionPnl: tgSession.sessionPnl, currentBet: tgSession.currentBet });
});

router.post("/tg/config", requireAuth, (req, res) => {
  if (!tgSession) { res.json({ ok: true }); return; }
  const body = req.body as Partial<BetCfg> & { startLevel?: number };
  const prev = { ...tgSession.cfg };
  tgSession.cfg = {
    autoBet: body.autoBet ?? prev.autoBet,
    betAmount: body.betAmount ?? prev.betAmount,
    strategy: body.strategy ?? prev.strategy,
    betMultiplier: body.betMultiplier ?? prev.betMultiplier,
    maxConsecutiveLosses: body.maxConsecutiveLosses ?? prev.maxConsecutiveLosses,
    stopLoss: body.stopLoss ?? prev.stopLoss,
    targetProfit: body.targetProfit ?? prev.targetProfit,
    cooldownSeconds: body.cooldownSeconds ?? prev.cooldownSeconds,
    amountLevels: body.amountLevels ?? prev.amountLevels,
    stepBackOnWin: body.stepBackOnWin ?? prev.stepBackOnWin,
    betOptions: body.betOptions ?? prev.betOptions,
    algorithms: body.algorithms ?? prev.algorithms,
  };

  if (body.amountLevels !== undefined || body.betAmount !== undefined || body.strategy !== undefined) {
    const lvl = Math.min(body.startLevel ?? 0, tgSession.cfg.amountLevels.length - 1);
    tgSession.currentLevel = lvl;
    tgSession.currentBet = tgSession.cfg.amountLevels[lvl] ?? tgSession.cfg.betAmount;
    tgSession.consecutiveLosses = 0;
  }
  if (body.algorithms !== undefined) tgSession.algIndex = 0;
  if (tgSession.watchGroupId) startGroupListener(tgSession);

  if (body.autoBet === false && prev.autoBet) stopPoller(tgSession);
  if (body.autoBet === true && !prev.autoBet && tgSession.watchGroupId) {
    tgSession.betPlacedThisCycle = false;
    tgSession.lastSeenLotteryPeriod = 0;
    startPoller(tgSession);
    void pollLottery(tgSession);
  }
  saveSession();
  res.json({ ok: true, cfg: tgSession.cfg });
});

router.post("/tg/kkpay", requireAuth, async (req, res) => {
  if (!tgSession) { res.status(401).json({ error: "未连接" }); return; }
  const { username } = req.body as { username?: string };
  if (username !== undefined) {
    tgSession.kkpayUsername = username.replace(/^@/, "");
    tgSession.kkpayEntityId = undefined;
    tgSession.balanceSource = "manual";
    await startKkpayListener(tgSession).catch(() => { /* ignore */ });
  }
  res.json({ ok: true, kkpayUsername: tgSession.kkpayUsername, kkpayEntityId: tgSession.kkpayEntityId, linked: !!tgSession.kkpayEntityId });
});

router.get("/tg/bets", requireAuth, (_req, res) => {
  res.json({ bets: betLog.slice(0, 100) });
});

router.delete("/tg/bets", requireAuth, (_req, res) => {
  betLog.length = 0;
  res.json({ ok: true });
});

router.get("/tg/events", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");
  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore */ } }, 20_000);
  req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
});

router.post("/tg/disconnect", requireAuth, async (_req, res) => {
  if (tgSession) {
    stopAllTimers(tgSession);
    try { await tgSession.client.invoke(new Api.auth.LogOut()); } catch { /* ok */ }
    try { await tgSession.client.disconnect(); } catch { /* ok */ }
  }
  tgSession = null;
  messageHandler = null;
  kkpayHandler = null;
  try { fs.unlinkSync(SESSION_FILE); } catch { /* ok */ }
  res.json({ ok: true });
});

export default router;
