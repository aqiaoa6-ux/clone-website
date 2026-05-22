import { Router, type Response } from "express";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import fs from "fs";
import path from "path";

const router = Router();

function getCredentials() {
  const apiId = parseInt(process.env["TELEGRAM_API_ID"] ?? "0", 10);
  const apiHash = process.env["TELEGRAM_API_HASH"] ?? "";
  return { apiId, apiHash };
}

type BetStrategy = "normal" | "martingale" | "anti-martingale";
type BetType =
  | "follow"
  | "big"
  | "small"
  | "odd"
  | "even"
  | "big-odd"
  | "big-even"
  | "small-odd"
  | "small-even";
type BetOption = "big" | "small" | "odd" | "even" | "big-odd" | "big-even" | "small-odd" | "small-even";
type AlgorithmId = "signal_follow" | "signal_reverse" | "streak_follow" | "cold_pick" | "random";
interface BetCfg {
  autoBet: boolean;
  betAmount: number;
  strategy: BetStrategy;
  betMultiplier: number;
  maxConsecutiveLosses: number;
  stopLoss: number;
  targetProfit: number;
  cooldownSeconds: number;
  betType: BetType;
  // advanced
  amountLevels: number[];
  stepBackOnWin: boolean;
  betOptions: BetOption[];
  algorithms: AlgorithmId[];
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
  // advanced state
  currentLevel: number;
  algIndex: number;
  recentResults: string[];
  // balance tracking
  balance: number;
  todayPnl: number;
  todayResetAt: number;
  // per-period dedup
  lastBetPeriod?: number;
  // kkpay integration
  kkpayUsername: string;
  kkpayEntityId?: string;
  balanceSource: "manual" | "kkpay";
  balanceUpdatedAt: number;
  // watchdog timers
  watchdogTimer?: ReturnType<typeof setInterval>;
  saveTimer?: ReturnType<typeof setInterval>;
  // 30-second post-result auto-bet timer
  autoNextBetTimer?: ReturnType<typeof setTimeout>;
}

// ─── Session persistence ──────────────────────────────────────────────────────
const SESSION_FILE = path.join(process.cwd(), ".tg-session.json");

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
  status: "sent" | "failed" | "paused" | "won" | "lost";
  pauseReason?: string;
  period?: number;
  lotteryResult?: string;
  pnl?: number;
  won?: boolean;
}

const DEFAULT_CFG: BetCfg = {
  autoBet: false,
  betAmount: 100,
  strategy: "normal",
  betMultiplier: 2,
  maxConsecutiveLosses: 5,
  stopLoss: 5000,
  targetProfit: 3000,
  cooldownSeconds: 0,
  betType: "follow",
  amountLevels: [100, 200, 300, 500, 1000],
  stepBackOnWin: true,
  betOptions: ["big", "small"],
  algorithms: ["signal_follow"],
};

const QUADRANT_OPTIONS: BetOption[] = ["big-odd", "big-even", "small-odd", "small-even"];

function todayMidnight(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parsePeriodFromMessage(text: string): number | undefined {
  const m = text.match(/第?(\d{6,10})期/);
  return m ? parseInt(m[1]) : undefined;
}

const BET_TYPE_TEXT: Record<BetType, string> = {
  follow: "", // determined from message
  big: "大",
  small: "小",
  odd: "单",
  even: "双",
  "big-odd": "大单",
  "big-even": "大双",
  "small-odd": "小单",
  "small-even": "小双",
};

let tgSession: TgSession | null = null;
const betLog: BetRecord[] = [];
// Store handler + the exact builder instance used at registration.
// GramJS removeEventHandler matches by object reference — creating a new
// NewMessage({}) for removal will NOT match the one used at addEventHandler.
let messageHandler: ((event: NewMessageEvent) => Promise<void>) | null = null;
let messageHandlerBuilder: NewMessage | null = null;
let kkpayHandler: ((event: NewMessageEvent) => Promise<void>) | null = null;
let kkpayHandlerBuilder: NewMessage | null = null;

// ─── TG client options (shared) ───────────────────────────────────────────────
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

// ─── Session save / restore ───────────────────────────────────────────────────
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

function stopWatchdog(session: TgSession): void {
  if (session.watchdogTimer) { clearInterval(session.watchdogTimer); session.watchdogTimer = undefined; }
  if (session.saveTimer) { clearInterval(session.saveTimer); session.saveTimer = undefined; }
  if (session.autoNextBetTimer) { clearTimeout(session.autoNextBetTimer); session.autoNextBetTimer = undefined; }
}

function startConnectionWatchdog(session: TgSession): void {
  stopWatchdog(session);

  // Periodic session save — every 5 min to capture refreshed auth tokens
  session.saveTimer = setInterval(() => {
    if (tgSession !== session) { clearInterval(session.saveTimer); return; }
    saveSession();
  }, 5 * 60 * 1000);

  // Connection health check — every 15 s via real getMe() ping
  session.watchdogTimer = setInterval(() => {
    if (tgSession !== session) { clearInterval(session.watchdogTimer); return; }
    void (async () => {
      try {
        await session.client.getMe(); // real round-trip ping
      } catch {
        // Ping failed — force a full reconnect cycle
        try {
          await session.client.connect();
          // Re-attach handlers after reconnect
          if (session.watchGroupId) startWatching(session);
          await startKkpayWatcher(session);
          saveSession();
          pushEvent("session:reconnected", { at: Date.now() });
        } catch { /* will retry next cycle */ }
      }
    })();
  }, 15 * 1000);
}

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
      client,
      stringSession,
      phone: data.phone ?? "",
      groups: await fetchGroups(client),
      cfg: data.cfg ? { ...DEFAULT_CFG, ...data.cfg } : { ...DEFAULT_CFG },
      consecutiveLosses: 0,
      sessionPnl: data.sessionPnl ?? 0,
      currentBet: data.cfg?.betAmount ?? DEFAULT_CFG.betAmount,
      lastBetAt: 0,
      currentLevel: 0,
      algIndex: 0,
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

    const restored = tgSession;
    // Re-establish the group message listener so group binding survives server restart
    if (restored.watchGroupId) startWatching(restored);
    startKkpayWatcher(restored).catch(() => { /* ignore */ });
    startConnectionWatchdog(restored);
  } catch {
    // Session expired — remove stale file so user can login fresh
    try { fs.unlinkSync(SESSION_FILE); } catch { /* ok */ }
  }
}

// Auto-restore saved session on server startup
void restoreSession();

// ─── SSE client registry ──────────────────────────────────────────────────────
const sseClients = new Set<Response>();

function pushEvent(type: string, payload: Record<string, unknown>): void {
  if (sseClients.size === 0) return;
  const data = JSON.stringify({ type, ...payload });
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
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
        membersCount:
          (d.entity as Api.Chat)?.participantsCount ?? undefined,
      }));
  } catch {
    return [];
  }
}

function parseBetFromMessage(text: string): string | null {
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


const BET_OPTION_LABELS: Record<BetOption, string> = {
  big: "大", small: "小", odd: "单", even: "双",
  "big-odd": "大单", "big-even": "大双", "small-odd": "小单", "small-even": "小双",
};

// ─── KKPay balance parsing ────────────────────────────────────────────────────
function parseBalanceFromKkpay(text: string): number | null {
  const patterns = [
    /当前余额[：:\s]*[¥￥]?\s*([\d,]+\.?\d*)/i,
    /(?:可用|账[户号])?余额[：:\s]*[¥￥]?\s*([\d,]+\.?\d*)/i,
    /balance[：:\s]*[¥￥]?\s*([\d,]+\.?\d*)/i,
    /剩余[：:\s]*[¥￥]?\s*([\d,]+\.?\d*)/i,
    /💰\s*[¥￥]?\s*([\d,]+\.?\d*)/,
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


// ─── Settle a bet result (shared by kkpayHandler auto-detect & /tg/bet-result) ─
function settleBet(
  session: TgSession,
  opts: { won: boolean; pnl?: number; result?: string; betId?: string; period?: number },
): void {
  const { won, pnl, result, betId, period } = opts;

  if (pnl !== undefined) {
    session.sessionPnl += pnl;
    session.balance += pnl;
    const midnight = todayMidnight();
    if (session.todayResetAt < midnight) {
      session.todayPnl = 0;
      session.todayResetAt = midnight;
    }
    session.todayPnl += pnl;
  }

  const record = betId
    ? betLog.find(b => b.id === betId)
    : betLog.find(b => b.status === "sent");
  if (record) {
    record.won = won;
    record.status = won ? "won" : "lost";
    if (pnl !== undefined) record.pnl = pnl;
    if (result) record.lotteryResult = result;
    // Backfill period onto the bet record if it wasn't set at bet time
    if (period && !record.period) record.period = period;
  }

  if (result) {
    session.recentResults.push(result);
    if (session.recentResults.length > 30) session.recentResults.shift();
  }

  session.consecutiveLosses = won ? 0 : session.consecutiveLosses + 1;
  session.currentBet = computeNextBet(session, won);

  if (record) {
    pushEvent("bet:result", {
      bet: record,
      balance: session.balance,
      todayPnl: session.todayPnl,
      sessionPnl: session.sessionPnl,
      totalBets:
        betLog.filter(b => b.status === "won" || b.status === "lost").length +
        betLog.filter(b => b.status === "sent").length,
      wins: betLog.filter(b => b.status === "won").length,
    });
  }
}

async function startKkpayWatcher(session: TgSession): Promise<void> {
  // Remove previous handler using the stored builder instance
  if (kkpayHandler && kkpayHandlerBuilder) {
    try { session.client.removeEventHandler(kkpayHandler, kkpayHandlerBuilder); } catch { /* ok */ }
    kkpayHandler = null;
    kkpayHandlerBuilder = null;
  }

  // Resolve entity ID for the configured kkpay username
  const uname = session.kkpayUsername.replace(/^@/, "");
  try {
    const entity = await session.client.getEntity(uname);
    session.kkpayEntityId = String((entity as unknown as { id: bigint | number }).id);
  } catch {
    // entity not found; handler will not match until resolved
  }

  kkpayHandler = async (event: NewMessageEvent) => {
    const msg = event.message;
    // Skip our own outgoing messages
    if (msg.out) return;

    const text = msg.message ?? "";
    if (!text) return;

    const chatId = String(msg.chatId ?? "");
    const senderId = String(msg.senderId ?? "");

    const wgid = session.watchGroupId;
    const eid = session.kkpayEntityId;

    // Match: (a) message from kkpay entity anywhere, OR (b) any message in the watch group
    const isFromKkpay = eid ? (senderId === eid || chatId === eid || `-100${chatId}` === eid) : false;
    const inWatchGroup = wgid ? (chatId === wgid || `-100${chatId}` === wgid) : false;

    if (!isFromKkpay && !inWatchGroup) return;

    // ── Win / loss auto-settle ────────────────────────────────────────────────
    // Support two kkpay result formats:
    //   Format A (KKCOIN):  "中奖 +700000 KKCOIN" / "挂逼 -100000 KKCOIN"
    //   Format B (单金额):  "3435823期: 4+1+8=13 小单 单金额 -39200 金额 400000"

    const hasWin  = /中奖|✅/.test(text);
    const hasLoss = /挂逼|未中|未赢|❌/.test(text);

    // Format B: detect win/loss from sign of 单金额
    let danjineWon: boolean | undefined;
    const danjineMatch = text.match(/单金额\s*([+-]?\d[\d,]*(?:\.\d+)?)/);
    if (danjineMatch && !hasWin && !hasLoss) {
      const val = parseFloat(danjineMatch[1].replace(/,/g, ""));
      danjineWon = val >= 0;
    }

    const isWin  = hasWin  || danjineWon === true;
    const isLoss = hasLoss || danjineWon === false;

    // Trigger settlement if: from kkpay entity, OR in watch group and looks like a result
    const isKkpayResult =
      isFromKkpay ||
      (inWatchGroup && (hasWin || hasLoss || danjineMatch !== null || /KKCOIN/i.test(text)));

    if (isKkpayResult && (isWin || isLoss) && tgSession === session) {
      const sentBet = betLog.find(b => b.status === "sent");
      if (sentBet) {
        // P&L — try KKCOIN format first, then 单金额 format
        const pnlMatch =
          text.match(/([+-][\d,]+(?:\.\d+)?)\s*KKCOIN/i) ??
          text.match(/KKCOIN\s*([+-][\d,]+(?:\.\d+)?)/i) ??
          (danjineMatch ? danjineMatch : null);
        const pnl = pnlMatch
          ? parseFloat(pnlMatch[1].replace(/,/g, ""))
          : undefined;

        // Lottery result label (大单/小双/大/小/单/双)
        const rMatch = text.match(/[大小][单双]|[大小]|[单双]/);

        // Period from result message (e.g. "3435823期")
        const periodFromMsg = parsePeriodFromMessage(text);

        settleBet(session, {
          won: isWin,
          pnl,
          result: rMatch?.[0],
          betId: sentBet.id,
          period: periodFromMsg,
        });

        // Schedule next auto-bet 50 seconds after result
        scheduleAutoNextBet(session);

        // Update absolute balance if kkpay includes it in the result message
        const absBal = parseBalanceFromKkpay(text);
        if (absBal !== null) {
          session.balance = absBal;
          session.balanceSource = "kkpay";
          session.balanceUpdatedAt = Date.now();
          pushEvent("balance:update", {
            balance: session.balance,
            balanceSource: session.balanceSource,
            balanceUpdatedAt: session.balanceUpdatedAt,
          });
          saveSession();
        }
      }
    }
  };

  kkpayHandlerBuilder = new NewMessage({});
  session.client.addEventHandler(kkpayHandler, kkpayHandlerBuilder);
}

function decideAlgorithm(session: TgSession, msgText: string): string | null {
  const { betOptions, algorithms } = session.cfg;

  // ── Algorithm-driven direction selection ─────────────────────────────────────
  const opts = betOptions;
  const algos = algorithms;
  if (!opts.length || !algos.length) return null;

  const enabledLabels = opts.map((o) => BET_OPTION_LABELS[o]);
  const algoId = algos[session.algIndex % algos.length];
  session.algIndex += 1;

  if (algoId === "signal_follow") {
    const parsed = parseBetFromMessage(msgText);
    if (!parsed) return null;
    return enabledLabels.includes(parsed) ? parsed : (enabledLabels[0] ?? null);
  }

  if (algoId === "signal_reverse") {
    const parsed = parseBetFromMessage(msgText);
    if (!parsed) return null;
    const opposite: Record<string, string> = {
      大: "小", 小: "大", 单: "双", 双: "单",
      大单: "小双", 大双: "小单", 小单: "大双", 小双: "大单",
    };
    const rev = opposite[parsed];
    if (rev && enabledLabels.includes(rev)) return rev;
    return enabledLabels[0] ?? null;
  }

  if (algoId === "streak_follow") {
    const recent = session.recentResults.slice(-10);
    if (!recent.length) return enabledLabels[0] ?? null;
    const freq: Record<string, number> = {};
    for (const r of recent) freq[r] = (freq[r] ?? 0) + 1;
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    return sorted.find(([k]) => enabledLabels.includes(k))?.[0] ?? enabledLabels[0] ?? null;
  }

  if (algoId === "cold_pick") {
    const recent = session.recentResults.slice(-10);
    const freq: Record<string, number> = {};
    for (const lbl of enabledLabels) freq[lbl] = 0;
    for (const r of recent) if (freq[r] !== undefined) freq[r]++;
    const sorted = Object.entries(freq).sort((a, b) => a[1] - b[1]);
    return sorted[0]?.[0] ?? enabledLabels[0] ?? null;
  }

  // random
  return enabledLabels[Math.floor(Math.random() * enabledLabels.length)] ?? null;
}

// ─── Stat-based direction (no signal text required) ──────────────────────────
// Used for the 30-second post-result auto-bet and the immediate start bet.
// signal_follow → streak_follow logic; signal_reverse → cold_pick logic.
function decideAlgorithmAuto(session: TgSession): string | null {
  const { betOptions, algorithms } = session.cfg;
  if (!betOptions.length || !algorithms.length) return null;

  const enabledLabels = betOptions.map((o) => BET_OPTION_LABELS[o]);
  const algoId = algorithms[session.algIndex % algorithms.length];
  session.algIndex += 1;

  // signal_follow → pick the most frequent recent result
  if (algoId === "signal_follow" || algoId === "streak_follow") {
    const recent = session.recentResults.slice(-10);
    if (!recent.length) return enabledLabels[Math.floor(Math.random() * enabledLabels.length)] ?? null;
    const freq: Record<string, number> = {};
    for (const r of recent) freq[r] = (freq[r] ?? 0) + 1;
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    return sorted.find(([k]) => enabledLabels.includes(k))?.[0] ?? enabledLabels[0] ?? null;
  }

  // signal_reverse → pick the least frequent recent result
  if (algoId === "signal_reverse" || algoId === "cold_pick") {
    const recent = session.recentResults.slice(-10);
    const freq: Record<string, number> = {};
    for (const lbl of enabledLabels) freq[lbl] = 0;
    for (const r of recent) if (freq[r] !== undefined) freq[r]++;
    const sorted = Object.entries(freq).sort((a, b) => a[1] - b[1]);
    return sorted[0]?.[0] ?? enabledLabels[0] ?? null;
  }

  // random
  return enabledLabels[Math.floor(Math.random() * enabledLabels.length)] ?? null;
}

// ─── Auto-place a bet immediately (no signal required) ────────────────────────
async function autoPlaceBet(session: TgSession): Promise<void> {
  if (!session.cfg.autoBet) return;
  const targetId = session.watchGroupId;
  if (!targetId) return;

  // Never bet while a previous bet is still awaiting a result
  if (betLog.some((b) => b.status === "sent")) return;

  const risk = checkRiskLimits(session);
  if (!risk.ok) {
    betLog.unshift({
      id: String(Date.now()),
      groupId: targetId,
      groupTitle: session.groups.find((g) => g.id === targetId || `-100${g.id}` === targetId)?.title ?? targetId,
      messageText: "[自动投注]",
      betContent: "",
      amount: session.currentBet,
      timestamp: Date.now(),
      status: "paused",
      pauseReason: risk.reason,
    });
    if (betLog.length > 200) betLog.pop();
    pushEvent("bet:new", { bet: betLog[0] });
    return;
  }

  const direction = decideAlgorithmAuto(session);
  if (!direction) return;

  const amount = session.currentBet;
  const groupTitle = session.groups.find((g) => g.id === targetId || `-100${g.id}` === targetId)?.title ?? targetId;

  try {
    await session.client.sendMessage(targetId, { message: `${direction}${amount}` });
    session.lastBetAt = Date.now();
    betLog.unshift({
      id: String(Date.now()),
      groupId: targetId,
      groupTitle,
      messageText: "[自动投注]",
      betContent: direction,
      amount,
      timestamp: Date.now(),
      status: "sent",
    });
    if (betLog.length > 200) betLog.pop();
    pushEvent("bet:new", { bet: betLog[0] });
  } catch {
    betLog.unshift({
      id: String(Date.now()),
      groupId: targetId,
      groupTitle,
      messageText: "[自动投注]",
      betContent: direction,
      amount,
      timestamp: Date.now(),
      status: "failed",
    });
    if (betLog.length > 200) betLog.pop();
    pushEvent("bet:new", { bet: betLog[0] });
  }
}

// ─── Schedule 50-second auto-bet after a result ───────────────────────────────
function scheduleAutoNextBet(session: TgSession): void {
  if (session.autoNextBetTimer) { clearTimeout(session.autoNextBetTimer); session.autoNextBetTimer = undefined; }
  if (!session.cfg.autoBet || !session.watchGroupId) return;
  session.autoNextBetTimer = setTimeout(() => {
    session.autoNextBetTimer = undefined;
    void autoPlaceBet(session);
  }, 50 * 1000);
}

function computeNextBet(session: TgSession, won: boolean): number {
  const { amountLevels, stepBackOnWin, betAmount, strategy, betMultiplier } = session.cfg;

  // Advanced: amountLevels-based progression
  if (amountLevels.length > 1) {
    let level = session.currentLevel;
    if (won) {
      if (stepBackOnWin) level = Math.max(0, level - 1);
    } else {
      level = Math.min(amountLevels.length - 1, level + 1);
    }
    session.currentLevel = level;
    return amountLevels[level]!;
  }

  // Fallback legacy strategy
  if (strategy === "normal") return betAmount;
  if (strategy === "martingale") {
    return won ? betAmount : Math.round(session.currentBet * betMultiplier);
  }
  return won ? Math.round(session.currentBet * betMultiplier) : betAmount;
}

/** Returns { ok, reason } — if !ok, do not send bet */
function checkRiskLimits(session: TgSession): { ok: boolean; reason?: string } {
  const { stopLoss, targetProfit, maxConsecutiveLosses, cooldownSeconds } =
    session.cfg;

  if (
    maxConsecutiveLosses > 0 &&
    session.consecutiveLosses >= maxConsecutiveLosses
  ) {
    return {
      ok: false,
      reason: `连亏${session.consecutiveLosses}局，已达上限${maxConsecutiveLosses}局`,
    };
  }
  if (stopLoss > 0 && session.sessionPnl <= -stopLoss) {
    return {
      ok: false,
      reason: `亏损 ¥${Math.abs(session.sessionPnl)} 已达止损 ¥${stopLoss}`,
    };
  }
  if (targetProfit > 0 && session.sessionPnl >= targetProfit) {
    return {
      ok: false,
      reason: `盈利 ¥${session.sessionPnl} 已达止盈 ¥${targetProfit}`,
    };
  }
  if (cooldownSeconds > 0) {
    const elapsed = (Date.now() - session.lastBetAt) / 1000;
    if (session.lastBetAt > 0 && elapsed < cooldownSeconds) {
      return {
        ok: false,
        reason: `冷却中 (${Math.ceil(cooldownSeconds - elapsed)}s)`,
      };
    }
  }
  return { ok: true };
}

function startWatching(session: TgSession) {
  if (!session.watchGroupId) return;

  if (messageHandler && messageHandlerBuilder) {
    try {
      session.client.removeEventHandler(messageHandler, messageHandlerBuilder);
    } catch { /* ok */ }
    messageHandler = null;
    messageHandlerBuilder = null;
  }

  const targetId = session.watchGroupId;

  messageHandler = async (event: NewMessageEvent) => {
    if (!session.cfg.autoBet) return;

    const msg = event.message;
    // Never react to our own outgoing messages — prevents bet loops
    if (msg.out) return;

    const chatId = String(msg.chatId);
    if (chatId !== targetId && `-100${chatId}` !== targetId) return;

    const senderId = String(msg.senderId ?? "");
    // Skip messages from the kkpay bot — those are balance replies, not signals
    if (session.kkpayEntityId && senderId === session.kkpayEntityId) return;

    const text = msg.message ?? "";

    // Never bet while a previous bet is still awaiting a result
    if (betLog.some((b) => b.status === "sent")) return;

    // Per-period dedup: only bet once per lottery period
    const triggerPeriod = parsePeriodFromMessage(text);
    if (triggerPeriod && triggerPeriod === session.lastBetPeriod) return;

    // Determine what to bet via algorithm or legacy betType
    let betContent: string;
    if (session.cfg.algorithms.length > 0 && session.cfg.betOptions.length > 0) {
      const decided = decideAlgorithm(session, text);
      if (!decided) return;
      betContent = decided;
    } else if (session.cfg.betType === "follow") {
      const parsed = parseBetFromMessage(text);
      if (!parsed) return;
      betContent = parsed;
    } else {
      betContent = BET_TYPE_TEXT[session.cfg.betType];
    }

    // Capture bet parameters at signal time (amount may change during the wait)
    const plannedContent = betContent;
    const plannedAmount = session.currentBet;
    const group = session.groups.find(
      (g) => g.id === targetId || `-100${g.id}` === targetId,
    );

    // Check risk limits before betting
    const risk = checkRiskLimits(session);
    if (!risk.ok) {
      betLog.unshift({
        id: String(Date.now()),
        groupId: targetId,
        groupTitle: group?.title ?? targetId,
        messageText: text.slice(0, 80),
        betContent: plannedContent,
        amount: plannedAmount,
        timestamp: Date.now(),
        status: "paused",
        pauseReason: risk.reason,
        period: triggerPeriod,
      });
      if (betLog.length > 200) betLog.pop();
      pushEvent("bet:new", { bet: betLog[0] });
      return;
    }

    // Cancel any pending 30-second auto-bet (signal takes priority)
    if (session.autoNextBetTimer) { clearTimeout(session.autoNextBetTimer); session.autoNextBetTimer = undefined; }

    // Bet immediately
    void (async () => {
      try {
        // Format: 大100 / 小100 / 小单100 / 大单100
        await session.client.sendMessage(targetId, {
          message: `${plannedContent}${plannedAmount}`,
        });
        session.lastBetAt = Date.now();
        if (triggerPeriod) session.lastBetPeriod = triggerPeriod;
        betLog.unshift({
          id: String(Date.now()),
          groupId: targetId,
          groupTitle: group?.title ?? targetId,
          messageText: text.slice(0, 80),
          betContent: plannedContent,
          amount: plannedAmount,
          timestamp: Date.now(),
          status: "sent",
          period: triggerPeriod,
        });
        if (betLog.length > 200) betLog.pop();
        pushEvent("bet:new", { bet: betLog[0] });
      } catch {
        betLog.unshift({
          id: String(Date.now()),
          groupId: targetId,
          groupTitle: group?.title ?? targetId,
          messageText: text.slice(0, 80),
          betContent: plannedContent,
          amount: plannedAmount,
          timestamp: Date.now(),
          status: "failed",
        });
        if (betLog.length > 200) betLog.pop();
      }
    })();
  };

  messageHandlerBuilder = new NewMessage({});
  session.client.addEventHandler(messageHandler, messageHandlerBuilder);
}

// ─── Send verification code ───────────────────────────────────────────────────
router.post("/tg/send-code", async (req, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) {
    res.status(400).json({ error: "请输入手机号" });
    return;
  }

  const { apiId, apiHash } = getCredentials();
  if (!apiId || !apiHash) {
    res
      .status(500)
      .json({ error: "服务端未配置 Telegram API 凭证，请联系管理员" });
    return;
  }

  try {
    if (tgSession?.client?.connected) {
      try {
        await tgSession.client.disconnect();
      } catch { /* ok */ }
    }

    const stringSession = new StringSession("");
    const client = new TelegramClient(stringSession, apiId, apiHash, makeClientOptions());

    await client.connect();
    const result = await client.sendCode({ apiId, apiHash }, phone);

    tgSession = {
      client,
      stringSession,
      phone,
      phoneCodeHash: result.phoneCodeHash,
      groups: [],
      cfg: { ...DEFAULT_CFG },
      consecutiveLosses: 0,
      sessionPnl: 0,
      currentBet: DEFAULT_CFG.betAmount,
      lastBetAt: 0,
      currentLevel: 0,
      algIndex: 0,
      recentResults: [],
      balance: 1000000,
      todayPnl: 0,
      todayResetAt: todayMidnight(),
      kkpayUsername: "kkpay",
      kkpayEntityId: undefined,
      balanceSource: "manual",
      balanceUpdatedAt: 0,
    };

    req.log.info({ phone }, "TG code sent");
    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, phone }, "send-code failed");
    if (msg.includes("PHONE_NUMBER_INVALID")) {
      res
        .status(400)
        .json({ error: "手机号格式错误（需含国家码，如 +8613800001234）" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ─── Verify code ─────────────────────────────────────────────────────────────
router.post("/tg/verify-code", async (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code) {
    res.status(400).json({ error: "请输入验证码" });
    return;
  }
  if (!tgSession) {
    res.status(400).json({ error: "请先发送验证码" });
    return;
  }

  const { apiId, apiHash } = getCredentials();

  try {
    const result = await tgSession.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: tgSession.phone,
        phoneCodeHash: tgSession.phoneCodeHash!,
        phoneCode: code,
      }),
    );

    const me = (result as Api.auth.Authorization).user as Api.User;
    tgSession.me = me;
    tgSession.groups = await fetchGroups(tgSession.client);
    startKkpayWatcher(tgSession).catch(() => { /* ignore */ });
    saveSession();
    startConnectionWatchdog(tgSession);

    req.log.info({ username: me.username }, "TG sign-in success");
    res.json({
      ok: true,
      me: {
        id: me.id,
        firstName: me.firstName,
        lastName: me.lastName,
        username: me.username,
        phone: me.phone,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SESSION_PASSWORD_NEEDED")) {
      res.json({ ok: false, needPassword: true });
      return;
    }
    if (
      msg.includes("PHONE_CODE_INVALID") ||
      msg.includes("CODE_INVALID")
    ) {
      res.status(400).json({ error: "验证码错误" });
      return;
    }
    if (msg.includes("PHONE_CODE_EXPIRED")) {
      res.status(400).json({ error: "验证码已过期，请重新获取" });
      return;
    }
    req.log.error({ err }, "verify-code failed");
    res.status(500).json({ error: msg });
  }
});

// ─── Verify 2FA password ──────────────────────────────────────────────────────
router.post("/tg/verify-password", async (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password) {
    res.status(400).json({ error: "请输入二步验证密码" });
    return;
  }
  if (!tgSession) {
    res.status(400).json({ error: "会话已失效，请重新登录" });
    return;
  }

  const { apiId, apiHash } = getCredentials();

  try {
    await tgSession.client.signInWithPassword(
      { apiId, apiHash },
      {
        password: async () => password,
        onError: async (err: Error) => {
          throw err;
        },
      },
    );

    const me = (await tgSession.client.getMe()) as Api.User;
    tgSession.me = me;
    tgSession.groups = await fetchGroups(tgSession.client);
    startKkpayWatcher(tgSession).catch(() => { /* ignore */ });
    saveSession();
    startConnectionWatchdog(tgSession);

    req.log.info({ username: me.username }, "TG 2FA success");
    res.json({
      ok: true,
      me: {
        id: me.id,
        firstName: me.firstName,
        lastName: me.lastName,
        username: me.username,
        phone: me.phone,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("PASSWORD_HASH_INVALID")) {
      res.status(400).json({ error: "二步验证密码错误" });
      return;
    }
    req.log.error({ err }, "verify-password failed");
    res.status(500).json({ error: msg });
  }
});

// ─── Status ───────────────────────────────────────────────────────────────────
router.get("/tg/status", (req, res) => {
  if (!tgSession?.me) {
    res.json({ connected: false });
    return;
  }

  // Reset todayPnl if a new day has started
  const midnight = todayMidnight();
  if (tgSession.todayResetAt < midnight) {
    tgSession.todayPnl = 0;
    tgSession.todayResetAt = midnight;
  }

  // Compute stats from betLog
  const settled = betLog.filter(b => b.won !== undefined);
  const totalBets = betLog.filter(b => b.status !== "failed").length;
  const winsCount = settled.filter(b => b.won === true).length;
  let maxStreak = 0, cur = 0;
  for (const b of [...betLog].reverse()) {
    if (b.won === true) { cur++; if (cur > maxStreak) maxStreak = cur; }
    else if (b.won === false) cur = 0;
  }
  const winRate = totalBets > 0 ? ((winsCount / totalBets) * 100).toFixed(2) : "0.00";

  const me = tgSession.me;
  res.json({
    connected: true,
    me: {
      id: me.id,
      firstName: me.firstName,
      lastName: me.lastName,
      username: me.username,
      phone: me.phone,
    },
    watchGroupId: tgSession.watchGroupId,
    ...tgSession.cfg,
    consecutiveLosses: tgSession.consecutiveLosses,
    sessionPnl: tgSession.sessionPnl,
    currentBet: tgSession.currentBet,
    balance: tgSession.balance,
    todayPnl: tgSession.todayPnl,
    totalBets,
    wins: winsCount,
    maxStreak,
    winRate,
    balanceSource: tgSession.balanceSource,
    balanceUpdatedAt: tgSession.balanceUpdatedAt,
    kkpayUsername: tgSession.kkpayUsername,
    kkpayEntityId: tgSession.kkpayEntityId,
  });
});

// ─── KKPay wallet config ──────────────────────────────────────────────────────
router.get("/tg/kkpay", (_req, res) => {
  if (!tgSession) {
    res.status(401).json({ error: "未登录" });
    return;
  }
  res.json({
    kkpayUsername: tgSession.kkpayUsername,
    kkpayEntityId: tgSession.kkpayEntityId,
    balanceSource: tgSession.balanceSource,
    balanceUpdatedAt: tgSession.balanceUpdatedAt,
    balance: tgSession.balance,
  });
});

router.post("/tg/kkpay", async (req, res) => {
  const { username } = req.body as { username?: string };
  if (!tgSession) {
    res.status(401).json({ error: "未登录" });
    return;
  }
  if (username !== undefined) {
    tgSession.kkpayUsername = username.replace(/^@/, "");
    tgSession.kkpayEntityId = undefined;
    tgSession.balanceSource = "manual";
    await startKkpayWatcher(tgSession).catch(() => { /* ignore */ });
  }
  res.json({
    ok: true,
    kkpayUsername: tgSession.kkpayUsername,
    kkpayEntityId: tgSession.kkpayEntityId,
    linked: !!tgSession.kkpayEntityId,
  });
});


// ─── Get / Set bet config ─────────────────────────────────────────────────────
router.get("/tg/config", (_req, res) => {
  if (!tgSession) {
    res.json({ cfg: DEFAULT_CFG });
    return;
  }
  res.json({
    cfg: tgSession.cfg,
    consecutiveLosses: tgSession.consecutiveLosses,
    sessionPnl: tgSession.sessionPnl,
    currentBet: tgSession.currentBet,
  });
});

router.post("/tg/config", (req, res) => {
  const body = req.body as Partial<BetCfg> & { startLevel?: number };

  if (!tgSession) {
    res.json({ ok: true, note: "no active session" });
    return;
  }

  const prev = tgSession.cfg;
  tgSession.cfg = {
    autoBet: body.autoBet ?? prev.autoBet,
    betAmount: body.betAmount ?? prev.betAmount,
    strategy: body.strategy ?? prev.strategy,
    betMultiplier: body.betMultiplier ?? prev.betMultiplier,
    maxConsecutiveLosses: body.maxConsecutiveLosses ?? prev.maxConsecutiveLosses,
    stopLoss: body.stopLoss ?? prev.stopLoss,
    targetProfit: body.targetProfit ?? prev.targetProfit,
    cooldownSeconds: body.cooldownSeconds ?? prev.cooldownSeconds,
    betType: body.betType ?? prev.betType,
    amountLevels: body.amountLevels ?? prev.amountLevels,
    stepBackOnWin: body.stepBackOnWin ?? prev.stepBackOnWin,
    betOptions: body.betOptions ?? prev.betOptions,
    algorithms: body.algorithms ?? prev.algorithms,
  };

  // Reset level / bet when amounts or level changes
  if (body.amountLevels !== undefined || body.betAmount !== undefined || body.strategy !== undefined) {
    const startLvl = body.startLevel ?? 0;
    tgSession.currentLevel = Math.min(startLvl, tgSession.cfg.amountLevels.length - 1);
    tgSession.currentBet = tgSession.cfg.amountLevels[tgSession.currentLevel] ?? tgSession.cfg.betAmount;
    tgSession.consecutiveLosses = 0;
  }

  // Reset algorithm rotation when algorithms change
  if (body.algorithms !== undefined) {
    tgSession.algIndex = 0;
  }

  if (tgSession.watchGroupId) startWatching(tgSession);

  // When autoBet is turned OFF — cancel any pending auto-bet timer immediately
  if (body.autoBet === false && prev.autoBet) {
    if (tgSession.autoNextBetTimer) {
      clearTimeout(tgSession.autoNextBetTimer);
      tgSession.autoNextBetTimer = undefined;
    }
  }

  // When autoBet is turned ON — immediately fire first bet (no signal needed)
  const wasOff = !prev.autoBet;
  if (body.autoBet === true && wasOff && tgSession.watchGroupId) {
    void autoPlaceBet(tgSession);
  }

  req.log.info({ cfg: tgSession.cfg }, "bet config updated");
  res.json({ ok: true, cfg: tgSession.cfg });
});

// ─── Report bet result (win/loss) to update martingale state ─────────────────
router.post("/tg/bet-result", (req, res) => {
  const { won, pnl, result, betId } = req.body as { won?: boolean; pnl?: number; result?: string; betId?: string };
  if (!tgSession) {
    res.status(401).json({ error: "未登录" });
    return;
  }

  if (won !== undefined) {
    settleBet(tgSession, { won, pnl, result, betId });
  }

  res.json({
    ok: true,
    consecutiveLosses: tgSession.consecutiveLosses,
    sessionPnl: tgSession.sessionPnl,
    currentBet: tgSession.currentBet,
    currentLevel: tgSession.currentLevel,
    balance: tgSession.balance,
    todayPnl: tgSession.todayPnl,
  });
});

// ─── Clear all bet records ────────────────────────────────────────────────────
router.delete("/tg/bets", (_req, res) => {
  betLog.length = 0;
  res.json({ ok: true });
});

// ─── Groups ───────────────────────────────────────────────────────────────────
router.get("/tg/groups", async (req, res) => {
  if (!tgSession?.client) {
    res.status(401).json({ error: "未登录" });
    return;
  }
  tgSession.groups = await fetchGroups(tgSession.client);
  res.json({ groups: tgSession.groups });
});

// ─── Resolve group by link/username ──────────────────────────────────────────
router.post("/tg/resolve-group", async (req, res) => {
  if (!tgSession?.client) {
    res.status(401).json({ error: "未登录" });
    return;
  }
  const { link } = req.body as { link?: string };
  if (!link) {
    res.status(400).json({ error: "请提供群链接" });
    return;
  }

  let username = link.trim();
  username = username.replace(/^https?:\/\/t\.me\//i, "");
  username = username.replace(/^@/, "");
  username = username.replace(/\?.*$/, "");

  try {
    const entity = await tgSession.client.getEntity(username);
    const id = String(
      (entity as unknown as { id: bigint | number }).id,
    );
    const title =
      (entity as { title?: string; firstName?: string }).title ??
      (entity as { firstName?: string }).firstName ??
      username;
    const isChannel = "broadcast" in entity;
    const group: GroupInfo = {
      id,
      title,
      type: isChannel ? "channel" : "group",
    };
    res.json({ ok: true, group });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, username }, "resolve-group failed");
    if (
      msg.includes("USERNAME_NOT_OCCUPIED") ||
      msg.includes("Cannot find")
    ) {
      res.status(404).json({ error: "找不到该群，请检查链接是否正确" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ─── Set watch group ──────────────────────────────────────────────────────────
router.post("/tg/set-group", (req, res) => {
  const { groupId } = req.body as { groupId?: string };
  if (!tgSession) {
    res.status(401).json({ error: "未登录" });
    return;
  }

  if (groupId !== undefined) tgSession.watchGroupId = groupId;
  if (tgSession.watchGroupId) startWatching(tgSession);

  res.json({ ok: true });
});

// ─── Bet log ──────────────────────────────────────────────────────────────────
router.get("/tg/bets", (_req, res) => {
  res.json({ bets: betLog.slice(0, 50) });
});

// ─── SSE event stream ─────────────────────────────────────────────────────────
router.get("/tg/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* ignore */ }
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// ─── Disconnect ───────────────────────────────────────────────────────────────
router.post("/tg/disconnect", async (_req, res) => {
  if (tgSession) {
    stopWatchdog(tgSession);
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
