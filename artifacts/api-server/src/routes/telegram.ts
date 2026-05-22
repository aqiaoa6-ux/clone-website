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
type PlayMode = "normal" | "double" | "kill";

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
  // play mode
  playMode: PlayMode;
  doubleGroupA: BetOption;
  doubleGroupB: BetOption;
  killOption: BetOption;
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
  // pending delayed bet (1-min after signal)
  pendingBetTimer?: ReturnType<typeof setTimeout>;
  // kkpay integration
  kkpayUsername: string;
  kkpayEntityId?: string;
  balanceSource: "manual" | "kkpay";
  balanceUpdatedAt: number;
  // watchdog timers
  watchdogTimer?: ReturnType<typeof setInterval>;
  saveTimer?: ReturnType<typeof setInterval>;
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
  playMode: "normal",
  doubleGroupA: "big-odd",
  doubleGroupB: "small-even",
  killOption: "big-odd",
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
  if (session.pendingBetTimer) { clearTimeout(session.pendingBetTimer); session.pendingBetTimer = undefined; }
}

function startConnectionWatchdog(session: TgSession): void {
  stopWatchdog(session);

  // Periodic session save — every 5 min to capture refreshed auth tokens
  session.saveTimer = setInterval(() => {
    if (tgSession !== session) { clearInterval(session.saveTimer); return; }
    saveSession();
  }, 5 * 60 * 1000);

  // Connection health check — every 30 s
  session.watchdogTimer = setInterval(() => {
    if (tgSession !== session) { clearInterval(session.watchdogTimer); return; }
    if (session.client.connected) return;
    void (async () => {
      try {
        await session.client.connect();
        // Re-attach handlers after reconnect (use stored builder instances)
        if (messageHandler && messageHandlerBuilder) {
          try { session.client.removeEventHandler(messageHandler, messageHandlerBuilder); } catch { /* ok */ }
          session.client.addEventHandler(messageHandler, messageHandlerBuilder);
        }
        if (kkpayHandler && kkpayHandlerBuilder) {
          try { session.client.removeEventHandler(kkpayHandler, kkpayHandlerBuilder); } catch { /* ok */ }
          session.client.addEventHandler(kkpayHandler, kkpayHandlerBuilder);
        }
        saveSession();
        pushEvent("session:reconnected", { at: Date.now() });
      } catch { /* will retry next cycle */ }
    })();
  }, 30 * 1000);
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

    startKkpayWatcher(tgSession).catch(() => { /* ignore */ });
    startConnectionWatchdog(tgSession);
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

// Send "ye" to the bet group — kkpay bot in the group responds with balance
function queryBalanceInGroup(session: TgSession, delayMs = 0): void {
  if (!session.watchGroupId) return;
  const fire = async () => {
    try {
      await session.client.sendMessage(session.watchGroupId!, { message: "ye" });
    } catch { /* ignore */ }
  };
  if (delayMs > 0) setTimeout(() => { void fire(); }, delayMs);
  else void fire();
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
    const text = msg.message ?? "";
    if (!text) return;

    const chatId = String(msg.chatId ?? "");
    const senderId = String(msg.senderId ?? "");

    const wgid = session.watchGroupId;
    const eid = session.kkpayEntityId;

    // Match: (a) message from kkpay entity anywhere, OR (b) any message in the watch group
    const isFromKkpay = eid && (senderId === eid || chatId === eid || `-100${chatId}` === eid);
    const inWatchGroup = wgid && (chatId === wgid || `-100${chatId}` === wgid);

    if (!isFromKkpay && !inWatchGroup) return;

    const bal = parseBalanceFromKkpay(text);
    if (bal !== null) {
      session.balance = bal;
      session.balanceSource = "kkpay";
      session.balanceUpdatedAt = Date.now();
      pushEvent("balance:update", {
        balance: session.balance,
        balanceSource: session.balanceSource,
        balanceUpdatedAt: session.balanceUpdatedAt,
      });
      saveSession();
    }
  };

  kkpayHandlerBuilder = new NewMessage({});
  session.client.addEventHandler(kkpayHandler, kkpayHandlerBuilder);
}

function decideAlgorithm(session: TgSession, msgText: string): string | null {
  const { playMode, betOptions, doubleGroupA, doubleGroupB, killOption, algorithms } = session.cfg;

  // ── Double mode: always bet the configured pair ──────────────────────────────
  if (playMode === "double") {
    // For signal modes, only bet when a signal is present
    const algoId = algorithms[session.algIndex % algorithms.length];
    session.algIndex += 1;
    if (algoId === "signal_follow" || algoId === "signal_reverse") {
      if (!parseBetFromMessage(msgText)) return null; // no signal → skip
    }
    return `${BET_OPTION_LABELS[doubleGroupA]}+${BET_OPTION_LABELS[doubleGroupB]}`;
  }

  // ── Kill mode: bet all quadrant options except the killed one ────────────────
  if (playMode === "kill") {
    const algoId = algorithms[session.algIndex % algorithms.length];
    session.algIndex += 1;
    if (algoId === "signal_follow" || algoId === "signal_reverse") {
      if (!parseBetFromMessage(msgText)) return null;
    }
    const active = QUADRANT_OPTIONS.filter((o) => o !== killOption);
    return active.map((o) => BET_OPTION_LABELS[o]).join("+");
  }

  // ── Normal mode: algorithm-driven direction selection ────────────────────────
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

    // Cancel any existing pending bet, then schedule 1 minute after signal
    if (session.pendingBetTimer) {
      clearTimeout(session.pendingBetTimer);
      session.pendingBetTimer = undefined;
    }

    session.pendingBetTimer = setTimeout(() => {
      session.pendingBetTimer = undefined;
      if (!session.cfg.autoBet) return;

      // Re-check risk limits at execution time
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
          // Send "ye" to the group to get updated balance from kkpay bot
          queryBalanceInGroup(session, 2000);
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
    }, 60 * 1000);
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

// ─── Manual balance refresh (sends "ye" to the bet group) ────────────────────
router.post("/tg/kkpay/refresh", (_req, res) => {
  if (!tgSession) {
    res.status(401).json({ error: "未登录" });
    return;
  }
  queryBalanceInGroup(tgSession, 0);
  res.json({ ok: true, querying: true });
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
    playMode: (body.playMode as PlayMode | undefined) ?? prev.playMode,
    doubleGroupA: (body.doubleGroupA as BetOption | undefined) ?? prev.doubleGroupA,
    doubleGroupB: (body.doubleGroupB as BetOption | undefined) ?? prev.doubleGroupB,
    killOption: (body.killOption as BetOption | undefined) ?? prev.killOption,
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

  if (pnl !== undefined) {
    tgSession.sessionPnl += pnl;
    // Update balance and todayPnl
    tgSession.balance += pnl;
    const midnight = todayMidnight();
    if (tgSession.todayResetAt < midnight) {
      tgSession.todayPnl = 0;
      tgSession.todayResetAt = midnight;
    }
    tgSession.todayPnl += pnl;
  }

  // Update the matching bet record
  const record = betId
    ? betLog.find(b => b.id === betId)
    : betLog.find(b => b.status === "sent");
  if (record) {
    if (won !== undefined) {
      record.won = won;
      record.status = won ? "won" : "lost";
    }
    if (pnl !== undefined) record.pnl = pnl;
    if (result) record.lotteryResult = result;
  }

  // Record recent result for algorithm 3 & 4
  if (result) {
    tgSession.recentResults.push(result);
    if (tgSession.recentResults.length > 30) tgSession.recentResults.shift();
  }

  if (won !== undefined) {
    if (won) {
      tgSession.consecutiveLosses = 0;
    } else {
      tgSession.consecutiveLosses += 1;
    }
    tgSession.currentBet = computeNextBet(tgSession, won);
    // Send "ye" to group to get updated balance from kkpay bot
    queryBalanceInGroup(tgSession, 1000);
  }

  // Push real-time event: updated record + latest stats
  if (record) {
    pushEvent("bet:result", {
      bet: record,
      balance: tgSession.balance,
      todayPnl: tgSession.todayPnl,
      sessionPnl: tgSession.sessionPnl,
      totalBets: betLog.filter(b => b.status === "won" || b.status === "lost").length +
                 betLog.filter(b => b.status === "sent").length,
      wins: betLog.filter(b => b.status === "won").length,
    });
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
