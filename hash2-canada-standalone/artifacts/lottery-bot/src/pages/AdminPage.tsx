import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";
import { api, type AdminCard, type AdminTgSession, type BetRecord, type TgChatMessage, type AdminUser, type GroupBetEntry } from "../lib/api";
import BottomNav from "../components/BottomNav";

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  daily: { label: "天卡", color: "text-green-400 bg-green-500/10 border-green-500/30" },
  weekly: { label: "周卡", color: "text-blue-400 bg-blue-500/10 border-blue-500/30" },
  monthly: { label: "月卡", color: "text-purple-400 bg-purple-500/10 border-purple-500/30" },
};

const PATTERN_LABELS: Record<string, { label: string; color: string }> = {
  streak: { label: "长龙", color: "text-orange-400" },
  oscillating: { label: "震荡", color: "text-blue-400" },
  neutral: { label: "中性", color: "text-slate-400" },
};

const pnlColor = (v: number) => v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-slate-400";

// kkpay full keyboard (matches kkpay bot menu in TG)
const KKPAY_KEYBOARD: string[][] = [
  ["🏦 充值", "🦅 提币"],
  ["⬆️ 转账", "⬇️ 收款"],
  ["🧧 红包"],
  ["💱 闪兑", "💳 匿名信用卡"],
  ["💎 电报会员/星星", "👤 个人中心"],
  ["👥 添加到群组", "🎮 自由承兑群"],
  ["🎮 OK游戏中心"],
  ["Ye", "菜单"],
];

const fmt = (v: number) => (v >= 0 ? "+" : "") + v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
const fmtTime = (ts: number) => new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtMsgTime = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
type PrivateSummaryDir = "大" | "小" | "单" | "双" | "大单" | "大双" | "小单" | "小双";
const PRIVATE_SUMMARY_DIRS: PrivateSummaryDir[] = ["大", "小", "单", "双", "大单", "大双", "小单", "小双"];
const ADMIN_VISIBLE_TABS = ["cards", "users", "shop"] as const;
const ADMIN_TAB_LABELS: Record<(typeof ADMIN_VISIBLE_TABS)[number], string> = {
  cards: "卡密管理",
  users: "账号管理",
  shop: "🛒 商店",
};

export default function AdminPage() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<"cards" | "monitor" | "users" | "pwdlog" | "shop" | "hashmon" | "privmon">("cards");
  type KillDir = "大单" | "大双" | "小单" | "小双";
  const KILL_DIRS: KillDir[] = ["大单", "大双", "小单", "小双"];
  const KILL_AMT_KEY = "hashmon_kill_amounts_v1";
  const [killAmts, setKillAmts] = useState<Record<KillDir, string>>(() => {
    try {
      const s = localStorage.getItem(KILL_AMT_KEY);
      if (s) {
        const v = JSON.parse(s) as Partial<Record<KillDir, string>>;
        return {
          大单: v.大单 ?? "1",
          大双: v.大双 ?? "1",
          小单: v.小单 ?? "1",
          小双: v.小双 ?? "1",
        };
      }
    } catch {}
    return { 大单: "1", 大双: "1", 小单: "1", 小双: "1" };
  });
  const [hashCopied, setHashCopied] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(KILL_AMT_KEY, JSON.stringify(killAmts)); } catch {}
  }, [killAmts]);

  // ── card tab ──
  const [cards, setCards] = useState<AdminCard[]>([]);
  const [loadingCards, setLoadingCards] = useState(true);
  const [type, setType] = useState<"daily" | "weekly" | "monthly">("weekly");
  const [count, setCount] = useState("1");
  const [note, setNote] = useState("");
  const [generating, setGenerating] = useState(false);
  const [newKeys, setNewKeys] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unused" | "active" | "expired">("all");
  const [showGenerate, setShowGenerate] = useState(false);
  const [generateError, setGenerateError] = useState("");

  // ── monitor tab ──
  const [sessions, setSessions] = useState<AdminTgSession[]>([]);
  const [loadingMon, setLoadingMon] = useState(false);
  const [expandedUser, setExpandedUser] = useState<number | null>(null);
  const [expandedView, setExpandedView] = useState<"bets" | "kkpay">("kkpay");
  const [userBets, setUserBets] = useState<Record<number, BetRecord[]>>({});
  const [loadingDetail, setLoadingDetail] = useState<number | null>(null);
  // kkpay console
  const [kkpayEntityId, setKkpayEntityId] = useState<Record<number, string | null>>({});
  const [kkpayMsgs, setKkpayMsgs] = useState<Record<number, TgChatMessage[]>>({});
  const [kkpaySending, setKkpaySending] = useState<number | null>(null);
  const [kkpayText, setKkpayText] = useState<Record<number, string>>({});
  const [kkpayTab, setKkpayTab] = useState<Record<number, "quick" | "transfer" | "inline" | "redpacket">>({});
  // transfer tab: contacts + search + selected contact + amount + unit
  type KkContact = { id: string; name: string; username: string | null; phone: string | null };
  const [kkpayContacts, setKkpayContacts] = useState<Record<number, KkContact[]>>({});
  const [kkpayContactSearch, setKkpayContactSearch] = useState<Record<number, string>>({});
  const [kkpayTransferContact, setKkpayTransferContact] = useState<Record<number, KkContact | null>>({});
  const [kkpayTransferAmt, setKkpayTransferAmt] = useState<Record<number, string>>({});
  const [kkpayTransferUnit, setKkpayTransferUnit] = useState<Record<number, string>>({});
  const [kkpayContactsLoading, setKkpayContactsLoading] = useState<number | null>(null);
  // transfer: payment password (after kkpay prompts for it) + sent flag
  const [kkpayTransferPayPwd, setKkpayTransferPayPwd] = useState<Record<number, string>>({});
  const [kkpayTransferSent, setKkpayTransferSent] = useState<Record<number, boolean>>({});
  // inline form: target chat + amount + unit
  const [kkpayIchat, setKkpayIchat] = useState<Record<number, string>>({});
  const [kkpayIamt, setKkpayIamt] = useState<Record<number, string>>({});
  const [kkpayIunit, setKkpayIunit] = useState<Record<number, string>>({});
  // custom transfer: manual TG ID + amount + unit (no contact list needed)
  const [kkpayCustomId, setKkpayCustomId] = useState<Record<number, string>>({});
  const [kkpayCustomAmt, setKkpayCustomAmt] = useState<Record<number, string>>({});
  const [kkpayCustomUnit, setKkpayCustomUnit] = useState<Record<number, string>>({});
  // button press loading: "userId:msgId:btnText"
  const [kkpayBtnLoading, setKkpayBtnLoading] = useState<string | null>(null);
  // redpacket tab: dialogs picker + amount
  type KkDialog = { id: string; name: string; type: "private" | "group" | "channel"; username: string | null };
  const [kkpayDialogs, setKkpayDialogs] = useState<Record<number, KkDialog[]>>({});
  const [kkpayDialogsLoading, setKkpayDialogsLoading] = useState<number | null>(null);
  const [kkpayDialogSearch, setKkpayDialogSearch] = useState<Record<number, string>>({});
  const [kkpayRpDialog, setKkpayRpDialog] = useState<Record<number, KkDialog | null>>({});
  const [kkpayRpAmt, setKkpayRpAmt] = useState<Record<number, string>>({});
  const [kkpayRpUnit, setKkpayRpUnit] = useState<Record<number, string>>({});
  const [kkpayDialogsError, setKkpayDialogsError] = useState<Record<number, string | null>>({});

  // Fetch TG dialogs (independent of kkpay button) — used by 红包转账 tab
  const loadDialogs = async (userId: number, alsoTriggerKkpay: boolean) => {
    setKkpayDialogsLoading(userId);
    setKkpayDialogsError(p => ({ ...p, [userId]: null }));
    // Fire kkpay button independently — its failure must NOT block dialog sync
    if (alsoTriggerKkpay) {
      void sendKkpay(userId, "🧧 红包");
    }
    try {
      const r = await api.admin.tgDialogs(userId);
      setKkpayDialogs(p => ({ ...p, [userId]: r.dialogs }));
      if (r.dialogs.length === 0) {
        setKkpayDialogsError(p => ({ ...p, [userId]: "TG 返回 0 个对话，请确认账号已连接" }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setKkpayDialogsError(p => ({ ...p, [userId]: `同步失败: ${msg}` }));
    } finally {
      setKkpayDialogsLoading(null);
    }
  };

  // ── users tab ──
  const [allUsers, setAllUsers] = useState<AdminUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [promotingId, setPromotingId] = useState<number | null>(null);

  // ── 后台二级密码门控 ──
  const [secretVerified, setSecretVerified] = useState(false);
  const [secretPwd, setSecretPwd] = useState("");
  const [secretError, setSecretError] = useState("");
  const [secretLoading, setSecretLoading] = useState(false);
  const [secretChecking, setSecretChecking] = useState(true);
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [changePwdOld, setChangePwdOld] = useState("");
  const [changePwdNew, setChangePwdNew] = useState("");
  const [changePwdErr, setChangePwdErr] = useState("");
  const [changePwdOk, setChangePwdOk] = useState(false);

  // ── shop tab ──
  interface ShopCfg { kkpayId: string; kkpaySecret: string; domain: string; productName: string; priceDailyUsdt: string; priceWeeklyUsdt: string; priceMonthlyUsdt: string; enabled: boolean; botToken: string }
  interface ShopOrder { id: number; orderId: string; username: string; cardType: string; amountUsdt: string; status: string; createdAt: string; paidAt: string | null; payUrl: string | null }
  const [shopCfg, setShopCfg] = useState<ShopCfg>({ kkpayId: "", kkpaySecret: "", domain: "", productName: "发财-飞投-卡密", priceDailyUsdt: "1", priceWeeklyUsdt: "5", priceMonthlyUsdt: "15", enabled: false, botToken: "" });
  const [shopOrders, setShopOrders] = useState<ShopOrder[]>([]);
  const [loadingShop, setLoadingShop] = useState(false);
  const [savingShop, setSavingShop] = useState(false);
  const [shopSaved, setShopSaved] = useState(false);
  const [showShopSecret, setShowShopSecret] = useState(false);
  const [showBotToken, setShowBotToken] = useState(false);
  const [settingWebhook, setSettingWebhook] = useState(false);
  const [webhookResult, setWebhookResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!ADMIN_VISIBLE_TABS.includes(tab as (typeof ADMIN_VISIBLE_TABS)[number])) {
      setTab("cards");
    }
  }, [tab]);

  const setupTgBot = async () => {
    setSettingWebhook(true); setWebhookResult(null);
    try {
      const r = await api.post<{ ok: boolean; webhookUrl?: string; botUsername?: string; error?: string }>("/admin/shop/setup-tg-bot", {});
      if (r.ok) {
        setWebhookResult({ ok: true, msg: `✅ 成功！Bot：@${r.botUsername ?? "?"} · ${r.webhookUrl ?? ""}` });
      } else {
        setWebhookResult({ ok: false, msg: r.error ?? "设置失败" });
      }
    } catch (e) {
      setWebhookResult({ ok: false, msg: e instanceof Error ? e.message : "设置失败" });
    } finally { setSettingWebhook(false); }
  };

  const [fulfillingOrder, setFulfillingOrder] = useState<string | null>(null);
  const [fulfillResult, setFulfillResult] = useState<Record<string, string>>({});

  const loadShop = async () => {
    setLoadingShop(true);
    try {
      const [cfg, orders] = await Promise.all([
        api.get<ShopCfg>("/admin/shop/config"),
        api.get<{ orders: ShopOrder[] }>("/admin/shop/orders"),
      ]);
      setShopCfg(cfg);
      setShopOrders(orders.orders);
    } catch { /* ignore */ } finally { setLoadingShop(false); }
  };

  const manualFulfill = async (orderId: string) => {
    setFulfillingOrder(orderId);
    try {
      const r = await api.post<{ ok: boolean; cardKey?: string; error?: string }>(`/admin/shop/orders/${orderId}/fulfill`, {});
      if (r.ok && r.cardKey) {
        setFulfillResult(p => ({ ...p, [orderId]: `✅ 已发货：${r.cardKey}` }));
        void loadShop();
      } else {
        setFulfillResult(p => ({ ...p, [orderId]: `❌ ${r.error ?? "发货失败"}` }));
      }
    } catch (e) {
      setFulfillResult(p => ({ ...p, [orderId]: `❌ ${e instanceof Error ? e.message : "发货失败"}` }));
    } finally { setFulfillingOrder(null); }
  };

  const saveShop = async () => {
    setSavingShop(true); setShopSaved(false);
    try {
      await api.post("/admin/shop/config", shopCfg);
      setShopSaved(true); setTimeout(() => setShopSaved(false), 2500);
    } catch { /* ignore */ } finally { setSavingShop(false); }
  };

  // ── hashmon tab ──
  const [hashBets, setHashBets] = useState<GroupBetEntry[]>([]);
  const [hashPeriod, setHashPeriod] = useState<string | null>(null);
  const [hashTerm, setHashTerm] = useState<number | null>(null);
  const [hashLastBetAt, setHashLastBetAt] = useState<number>(0);
  const [nowTs, setNowTs] = useState(() => Date.now());
  // 停止下注后快照数据（等待开奖时展示）
  const [hashSnap, setHashSnap] = useState<{ term: number; dirs: Record<string, { kk: number; usdt: number; cny: number }>; closedAt: number } | null>(null);
  type PeriodRecord = {
    term: number | null;
    result: string | null;
    closedAt: number;
    dirs: Record<string, { kk: number; usdt: number; cny: number }>;
  };
  const SS_KEY = "hashHistory_v1";
  const [hashHistory, setHashHistoryRaw] = useState<PeriodRecord[]>(() => {
    try {
      const s = sessionStorage.getItem(SS_KEY);
      return s ? (JSON.parse(s) as PeriodRecord[]) : [];
    } catch { return []; }
  });
  const setHashHistory = (updater: PeriodRecord[] | ((prev: PeriodRecord[]) => PeriodRecord[])) => {
    setHashHistoryRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      try { sessionStorage.setItem(SS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const mergeHistory = (prev: PeriodRecord[], incoming: PeriodRecord[]): PeriodRecord[] => {
    if (!incoming.length) return prev;
    const map = new Map(prev.map(r => [r.term, r]));
    for (const r of incoming) {
      const ex = map.get(r.term);
      if (!ex) { map.set(r.term, r); continue; }
      const hasBets = (d: PeriodRecord) => Object.values(d.dirs).some(v => v.kk + v.usdt + v.cny > 0);
      map.set(r.term, {
        ...ex,
        result: r.result ?? ex.result,
        closedAt: r.closedAt || ex.closedAt,
        dirs: hasBets(r) ? r.dirs : ex.dirs,
      });
    }
    return Array.from(map.values()).sort((a, b) => (b.term ?? 0) - (a.term ?? 0)).slice(0, 30);
  };
  const hashSseRef = useRef<EventSource | null>(null);
  const betBufferRef = useRef<GroupBetEntry[]>([]);
  const resetPendingRef = useRef<{ bets: GroupBetEntry[]; period: string | null } | null>(null);
  const latestPeriodRef = useRef<string | null>(null);
  const latestTermRef = useRef<number | null>(null);
  const latestLastBetAtRef = useRef<number>(0);
  // 加拿大监控 — 多群组管理
  type CanadaMonGroup = { groupId: string; groupTitle: string | undefined; active: boolean };
  const [canadaGroups, setCanadaGroups] = useState<CanadaMonGroup[]>([]);
  const [canadaPickerOpen, setCanadaPickerOpen] = useState(false);
  const [groupsCollapsed, setGroupsCollapsed] = useState(true);
  const [canadaPickerList, setCanadaPickerList] = useState<{ id: string; title: string; type: string }[]>([]);
  const [canadaPickerSearch, setCanadaPickerSearch] = useState("");
  const [canadaPickerSaving, setCanadaPickerSaving] = useState<string | null>(null);

  const loadCanadaGroups = async () => {
    try {
      const r = await api.admin.canadaMonitorGroups();
      setCanadaGroups(r.groups);
    } catch { /* ignore */ }
  };

  const openCanadaPicker = async () => {
    setCanadaPickerOpen(true);
    setCanadaPickerSearch("");
    try {
      const r = await api.admin.tgGroups();
      const all: { id: string; title: string; type: string }[] = [];
      for (const s of r.sessions) all.push(...s.groups);
      setCanadaPickerList(all);
    } catch { /* ignore */ }
  };

  const addCanadaGroup = async (groupId: string) => {
    setCanadaPickerSaving(groupId);
    try {
      const r = await api.admin.addCanadaMonitorGroup(groupId);
      setCanadaGroups(prev => {
        if (prev.some(g => g.groupId === r.groupId)) return prev;
        return [...prev, { groupId: r.groupId, groupTitle: r.groupTitle, active: true }];
      });
    } catch { /* ignore */ } finally { setCanadaPickerSaving(null); }
  };

  const clearCanadaMonitorLocal = () => {
    betBufferRef.current = [];
    resetPendingRef.current = null;
    setHashBets([]);
    setHashPeriod(null);
    setHashTerm(null);
    setHashLastBetAt(0);
    setHashSnap(null);
    setHashHistory([]);
  };

  const removeCanadaGroup = async (groupId: string) => {
    try {
      await api.admin.removeCanadaMonitorGroup(groupId);
      setCanadaGroups(prev => prev.filter(g => g.groupId !== groupId));
    } catch { /* ignore */ }
  };

  type PrivateMonGroup = { groupId: string; groupTitle: string | undefined; active: boolean };
  const [privateGroups, setPrivateGroups] = useState<PrivateMonGroup[]>([]);
  const [privatePickerOpen, setPrivatePickerOpen] = useState(false);
  const [privatePickerList, setPrivatePickerList] = useState<{ id: string; title: string; type: string }[]>([]);
  const [privatePickerSearch, setPrivatePickerSearch] = useState("");
  const [privatePickerSaving, setPrivatePickerSaving] = useState<string | null>(null);
  const privateSseRef = useRef<EventSource | null>(null);
  const [privateBets, setPrivateBets] = useState<GroupBetEntry[]>([]);
  const [privateTerm, setPrivateTerm] = useState<number | null>(null);
  const [privateLastBetAt, setPrivateLastBetAt] = useState<number>(0);
  const privateBetBufferRef = useRef<GroupBetEntry[]>([]);
  const privateSummary = useMemo(() => {
    const totals: Record<PrivateSummaryDir, number> = {
      大: 0, 小: 0, 单: 0, 双: 0, 大单: 0, 大双: 0, 小单: 0, 小双: 0,
    };
    const add = (dir: PrivateSummaryDir, amount: number) => { totals[dir] += amount; };

    for (const b of privateBets) {
      const amount = Number(b.amount);
      if (!isFinite(amount) || amount <= 0) continue;
      const dir = b.direction.trim() as PrivateSummaryDir | string;
      if (dir in totals) add(dir as PrivateSummaryDir, amount);
    }

    return PRIVATE_SUMMARY_DIRS.map(dir => ({ dir, amount: totals[dir] }));
  }, [privateBets]);

  const loadPrivateGroups = async () => {
    try {
      const r = await api.admin.privateMonitorGroups();
      setPrivateGroups(r.groups);
    } catch { /* ignore */ }
  };

  const openPrivatePicker = async () => {
    setPrivatePickerOpen(true);
    setPrivatePickerSearch("");
    try {
      const r = await api.admin.tgGroups();
      const all: { id: string; title: string; type: string }[] = [];
      for (const s of r.sessions) all.push(...s.groups);
      setPrivatePickerList(all);
    } catch { /* ignore */ }
  };

  const addPrivateGroup = async (groupId: string) => {
    setPrivatePickerSaving(groupId);
    try {
      const r = await api.admin.addPrivateMonitorGroup(groupId);
      setPrivateGroups(prev => {
        if (prev.some(g => g.groupId === r.groupId)) return prev;
        return [...prev, { groupId: r.groupId, groupTitle: r.groupTitle, active: true }];
      });
    } catch { /* ignore */ } finally { setPrivatePickerSaving(null); }
  };

  const removePrivateGroup = async (groupId: string) => {
    try {
      await api.admin.removePrivateMonitorGroup(groupId);
      setPrivateGroups(prev => prev.filter(g => g.groupId !== groupId));
    } catch { /* ignore */ }
  };

  // ── pwd log tab ──
  type PwdLogEvent = { id: string; timestamp: number; userId: number; username: string; event: "pwd_requested" | "pwd_sent" | "pwd_success"; text: string; context?: string };
  const [pwdLog, setPwdLog] = useState<PwdLogEvent[]>([]);
  const [loadingPwdLog, setLoadingPwdLog] = useState(false);
  const todayCst = () => {
    const now = new Date();
    return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  };
  const [pwdLogDate, setPwdLogDate] = useState<string>(todayCst);

  const loadPwdLog = async (date?: string) => {
    setLoadingPwdLog(true);
    try {
      const r = await api.admin.kkpayPwdLog(date ?? pwdLogDate);
      setPwdLog(r.events);
    } catch { /* ignore */ } finally { setLoadingPwdLog(false); }
  };

  const exportPwdLogCsv = () => {
    const header = ["时间", "用户名", "用户ID", "事件", "内容", "场景"];
    const rows = pwdLog.map(ev => [
      new Date(ev.timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      ev.username,
      String(ev.userId),
      ev.event === "pwd_requested" ? "请求密码" : ev.event === "pwd_sent" ? "发出密码" : "验证成功",
      ev.text.replace(/"/g, '""'),
      (ev.context ?? "").replace(/"/g, '""'),
    ]);
    const csv = [header, ...rows].map(r => r.map(c => `"${c}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `密码日志-${pwdLogDate}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (!user?.isAdmin) { setLocation("/"); return; }
    // 检查后台密码是否已验证
    api.admin.authStatus().then(r => {
      setSecretVerified(r.verified);
    }).catch(() => {
      setSecretVerified(false);
    }).finally(() => {
      setSecretChecking(false);
    });
    void loadCards();
  }, [user, setLocation]);

  const handleSecretVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setSecretLoading(true); setSecretError("");
    try {
      const r = await api.admin.authVerify(secretPwd);
      if (r.ok) {
        setSecretVerified(true);
        setSecretPwd("");
        if (r.firstTime) setSecretError("首次设置成功，已记住该密码");
        await loadCards();
      }
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : "验证失败");
    } finally { setSecretLoading(false); }
  };

  const handleChangePwd = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangePwdErr(""); setChangePwdOk(false);
    try {
      await api.admin.authChange(changePwdOld, changePwdNew);
      setChangePwdOk(true); setChangePwdOld(""); setChangePwdNew("");
      setTimeout(() => setShowChangePwd(false), 1500);
    } catch (err) {
      setChangePwdErr(err instanceof Error ? err.message : "修改失败");
    }
  };

  const handleSecretLogout = async () => {
    await api.admin.authLogout();
    setSecretVerified(false);
    setSecretPwd("");
  };

  useEffect(() => {
    if (tab === "monitor") void loadSessions();
    if (tab === "users") void loadUsers();
    if (tab === "pwdlog") void loadPwdLog(pwdLogDate);
    if (tab === "shop") void loadShop();
    if (tab === "hashmon") void loadCanadaGroups();
    if (tab === "privmon") void loadPrivateGroups();
  }, [tab]);

  // 1s 心跳：驱动"X秒前"新鲜度显示
  useEffect(() => {
    if (tab !== "hashmon" && tab !== "privmon") return;
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [tab]);

  // Hash monitor SSE — connect when tab is active, disconnect otherwise
  useEffect(() => {
    if (tab !== "hashmon" || !secretVerified) {
      if (hashSseRef.current) { hashSseRef.current.close(); hashSseRef.current = null; }
      return;
    }
    betBufferRef.current = [];
    resetPendingRef.current = null;

    let destroyed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // 先 REST 拉一次历史，防止 SSE init 竞态导致历史为空
    void fetch("/api/admin/hash-period-history", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { history?: PeriodRecord[] } | null) => {
        if (d?.history && d.history.length > 0) setHashHistory(prev => mergeHistory(prev, d.history!));
      }).catch(() => { /* ignore */ });

    const connect = () => {
      if (destroyed) return;
      const es = new EventSource("/api/admin/hash-group-bets/events", { withCredentials: true });
      hashSseRef.current = es;

      es.onmessage = (e) => {
        if (!e.data) return;
        try {
          const ev = JSON.parse(e.data as string) as Record<string, unknown>;
          if (ev.type === "init") {
            betBufferRef.current = [];
            resetPendingRef.current = null;
            setHashBets((ev.bets as GroupBetEntry[]) ?? []);
            setHashPeriod((ev.period as string | null) ?? null);
            if (ev.term) setHashTerm(ev.term as number);
            if (ev.lastBetAt) setHashLastBetAt(ev.lastBetAt as number);
            if (ev.history && (ev.history as PeriodRecord[]).length > 0) setHashHistory(prev => mergeHistory(prev, ev.history as PeriodRecord[]));
          } else if (ev.type === "bets:batch") {
            const bets = (ev.bets as GroupBetEntry[]) ?? [];
            if (ev.period) latestPeriodRef.current = ev.period as string;
            if (ev.term) latestTermRef.current = ev.term as number;
            if (ev.lastBetAt) latestLastBetAtRef.current = ev.lastBetAt as number;
            for (const b of bets) betBufferRef.current.push(b);
          } else if (ev.type === "bets:cleanup") {
            betBufferRef.current = [];
            resetPendingRef.current = null;
            setHashPeriod((ev.period as string | null) ?? null);
            void fetch("/api/admin/hash-group-bets", { credentials: "include" })
              .then(r => r.ok ? r.json() : null)
              .then((d: { bets?: GroupBetEntry[]; period?: string | null } | null) => {
                if (d?.bets) { setHashBets(d.bets); setHashPeriod(d.period ?? null); }
              }).catch(() => { /* ignore */ });
          } else if (ev.type === "history:update") {
            if (ev.history && (ev.history as PeriodRecord[]).length > 0) setHashHistory(prev => mergeHistory(prev, ev.history as PeriodRecord[]));
          } else if (ev.type === "bet:new") {
            betBufferRef.current.push(ev.bet as GroupBetEntry);
          } else if (ev.type === "bets:reset") {
            betBufferRef.current = [];
            latestTermRef.current = null;
            if (ev.lastBetAt) {
              latestLastBetAtRef.current = ev.lastBetAt as number;
              setHashLastBetAt(ev.lastBetAt as number);
            }
            if (ev.term) setHashTerm(ev.term as number);
            if (ev.snap) setHashSnap(ev.snap as { term: number; dirs: Record<string, { kk: number; usdt: number; cny: number }>; closedAt: number });
            else setHashSnap(null);
            resetPendingRef.current = {
              bets: (ev.bets as GroupBetEntry[]) ?? [],
              period: (ev.period as string | null) ?? null,
            };
          }
        } catch { /* ignore */ }
      };

      // 断线自动重连（生产代理每5分钟断一次）
      es.onerror = () => {
        es.close();
        hashSseRef.current = null;
        if (!destroyed) reconnectTimer = setTimeout(connect, 2000);
      };
    };

    connect();

    // 每 1s flush 一次缓冲，多群消息合并为一次 setState
    const flushId = setInterval(() => {
      const reset = resetPendingRef.current;
      const buf = betBufferRef.current;
      if (reset === null && buf.length === 0) return;
      betBufferRef.current = [];

      // 批量更新 period / term / lastBetAt
      if (latestPeriodRef.current) { setHashPeriod(latestPeriodRef.current); latestPeriodRef.current = null; }
      if (latestTermRef.current) { setHashTerm(latestTermRef.current); latestTermRef.current = null; }
      if (latestLastBetAtRef.current > 0) { setHashLastBetAt(latestLastBetAtRef.current); latestLastBetAtRef.current = 0; }

      if (buf.length > 0) {
        const newBets = [...buf].reverse();
        if (reset !== null) {
          resetPendingRef.current = null;
          setHashBets([...reset.bets, ...newBets].slice(0, 500));
          setHashPeriod(reset.period);
        } else {
          setHashBets(prev => [...newBets, ...prev].slice(0, 500));
        }
      } else if (reset !== null) {
        resetPendingRef.current = null;
        setHashBets(reset.bets.slice(0, 500));
        setHashPeriod(reset.period);
      }
    }, 1000);

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(flushId);
      if (hashSseRef.current) { hashSseRef.current.close(); hashSseRef.current = null; }
    };
  }, [tab, secretVerified]);

  useEffect(() => {
    if (tab !== "privmon" || !secretVerified) {
      if (privateSseRef.current) { privateSseRef.current.close(); privateSseRef.current = null; }
      return;
    }
    privateBetBufferRef.current = [];

    let destroyed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (destroyed) return;
      const es = new EventSource("/api/admin/private-bets/events", { withCredentials: true });
      privateSseRef.current = es;

      es.onmessage = (e) => {
        if (!e.data) return;
        try {
          const ev = JSON.parse(e.data as string) as Record<string, unknown>;
          if (ev.type === "init") {
            privateBetBufferRef.current = [];
            setPrivateBets((ev.bets as GroupBetEntry[]) ?? []);
            setPrivateTerm((ev.term as number | null) ?? null);
            setPrivateLastBetAt((ev.lastBetAt as number) ?? 0);
          } else if (ev.type === "bets:reset") {
            privateBetBufferRef.current = [];
            setPrivateBets((ev.bets as GroupBetEntry[]) ?? []);
            setPrivateTerm((ev.term as number | null) ?? null);
            setPrivateLastBetAt((ev.lastBetAt as number) ?? 0);
          } else if (ev.type === "bets:batch") {
            const bets = (ev.bets as GroupBetEntry[]) ?? [];
            if (ev.term) setPrivateTerm(ev.term as number);
            if (ev.lastBetAt) setPrivateLastBetAt(ev.lastBetAt as number);
            for (const b of bets) privateBetBufferRef.current.push(b);
          } else if (ev.type === "bets:cleanup") {
            privateBetBufferRef.current = [];
            void fetch("/api/admin/private-bets", { credentials: "include" })
              .then(r => r.ok ? r.json() : null)
              .then((d: { bets?: GroupBetEntry[]; term?: number | null } | null) => {
                if (d?.bets) { setPrivateBets(d.bets); setPrivateTerm(d.term ?? null); }
              }).catch(() => { /* ignore */ });
          }
        } catch { /* ignore */ }
      };

      es.onerror = () => {
        if (destroyed) return;
        try { es.close(); } catch {}
        privateSseRef.current = null;
        if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
      };
    };

    connect();

    const flushId = setInterval(() => {
      const buf = privateBetBufferRef.current;
      if (buf.length === 0) return;
      privateBetBufferRef.current = [];
      const newBets = [...buf].reverse();
      setPrivateBets(prev => [...newBets, ...prev].slice(0, 500));
    }, 1000);

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(flushId);
      if (privateSseRef.current) { privateSseRef.current.close(); privateSseRef.current = null; }
    };
  }, [tab, secretVerified]);

  // Auto-poll kkpay every 5s while kkpay console is open
  useEffect(() => {
    if (!expandedUser || expandedView !== "kkpay") return;
    const uid = expandedUser;
    const id = setInterval(() => { void fetchKkpay(uid, true); }, 5000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedUser, expandedView]);

  const loadCards = async () => {
    setLoadingCards(true);
    try { const { cards: c } = await api.admin.listCards(); setCards(c); }
    finally { setLoadingCards(false); }
  };

  const loadSessions = async () => {
    setLoadingMon(true);
    try { const { sessions: s } = await api.admin.tgSessions(); setSessions(s); }
    finally { setLoadingMon(false); }
  };

  const loadUsers = async () => {
    setLoadingUsers(true);
    try { const { users: u } = await api.admin.listUsers(); setAllUsers(u); }
    finally { setLoadingUsers(false); }
  };

  const openUserDetail = async (userId: number, view: "bets" | "kkpay") => {
    if (expandedUser === userId && expandedView === view) { setExpandedUser(null); return; }
    setExpandedUser(userId);
    setExpandedView(view);
    if (view === "bets" && !userBets[userId]) {
      setLoadingDetail(userId);
      try { const { bets } = await api.admin.tgBets(userId); setUserBets(p => ({ ...p, [userId]: bets })); }
      finally { setLoadingDetail(null); }
    }
    if (view === "kkpay") void fetchKkpay(userId);
  };

  const fetchKkpay = async (userId: number, silent = false) => {
    if (!silent) setLoadingDetail(userId);
    try {
      const { entityId, messages } = await api.admin.tgKkpay(userId);
      setKkpayEntityId(p => ({ ...p, [userId]: entityId }));
      // Live endpoint returns both outgoing and incoming sorted newest-first
      setKkpayMsgs(p => {
        if (messages.length === 0) return p;
        return { ...p, [userId]: messages };
      });
    } catch { /* ignore */ } finally {
      if (!silent) setLoadingDetail(null);
    }
  };

  const sendKkpay = async (userId: number, overrideText?: string) => {
    const text = overrideText ?? (kkpayText[userId] ?? "").trim();
    if (!text) return;
    const entityId = kkpayEntityId[userId] ?? null;
    setKkpaySending(userId);
    try {
      await api.admin.tgSend(userId, entityId, entityId ? null : "kkpay", text);
      if (!overrideText) setKkpayText(p => ({ ...p, [userId]: "" }));
      const outgoing: TgChatMessage = {
        sender: "__me__", senderName: "我",
        chatId: entityId ?? "kkpay", chatTitle: "kkpay", chatType: "private",
        text, timestamp: Date.now(),
      };
      setKkpayMsgs(p => ({ ...p, [userId]: [outgoing, ...(p[userId] ?? [])] }));
      setTimeout(() => { void fetchKkpay(userId, true); }, 2000);
      setTimeout(() => { void fetchKkpay(userId, true); }, 5000);
    } catch { /* ignore */ } finally { setKkpaySending(null); }
  };

  const setAdmin = async (userId: number, isAdmin: boolean) => {
    setPromotingId(userId);
    try {
      await api.admin.setAdmin(userId, isAdmin);
      await loadUsers();
    } finally { setPromotingId(null); }
  };

  const generate = async () => {
    setGenerating(true); setNewKeys([]); setGenerateError("");
    try {
      const { keys } = await api.admin.generateCards(type, Number(count) || 1, note || undefined);
      setNewKeys(keys); await loadCards();
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "生成失败");
    } finally { setGenerating(false); }
  };

  const deleteCard = async (id: number) => {
    if (!confirm("确认删除此卡密？")) return;
    await api.admin.deleteCard(id); await loadCards();
  };

  const copyKey = (key: string) => {
    void navigator.clipboard.writeText(key); setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };
  const copyAll = (keys: string[]) => {
    void navigator.clipboard.writeText(keys.join("\n")); setCopied("all");
    setTimeout(() => setCopied(null), 2000);
  };

  const filtered = cards.filter(c => {
    if (filter === "unused") return !c.isUsed;
    if (filter === "active") return c.isActive;
    if (filter === "expired") return c.isUsed && !c.isActive;
    return true;
  });

  const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
  const tgName = (s: AdminTgSession) =>
    [s.me.firstName, s.me.lastName].filter(Boolean).join(" ") || s.me.username || s.me.phone || `用户${s.userId}`;

  // 正在检查验证状态
  if (secretChecking) {
    return (
      <div className="min-h-screen bg-[#0b0e1a] flex items-center justify-center">
        <span className="text-slate-500 text-sm">验证中…</span>
      </div>
    );
  }

  // 未通过后台密码验证：显示验证弹窗
  if (!secretVerified) {
    return (
      <div className="min-h-screen bg-[#0b0e1a] flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-[#12162a] border border-[#1e2235] rounded-2xl p-6 space-y-5">
          <div className="text-center space-y-1">
            <div className="text-3xl">🔐</div>
            <h2 className="text-white font-bold text-lg">后台二级验证</h2>
            <p className="text-slate-400 text-sm">请输入后台独立密码以继续</p>
            <p className="text-slate-500 text-xs">（与登录密码不同，首次输入将作为密码保存）</p>
          </div>
          <form onSubmit={e => void handleSecretVerify(e)} className="space-y-3">
            <input
              type="password"
              value={secretPwd}
              onChange={e => setSecretPwd(e.target.value)}
              placeholder="后台密码"
              autoFocus
              className="w-full bg-[#0b0e1a] border border-[#2a2f45] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition"
            />
            {secretError && (
              <p className={`text-xs text-center ${secretError.includes("成功") ? "text-emerald-400" : "text-red-400"}`}>{secretError}</p>
            )}
            <button
              type="submit"
              disabled={secretLoading || !secretPwd}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium py-3 rounded-xl transition text-sm"
            >
              {secretLoading ? "验证中…" : "进入后台"}
            </button>
          </form>
          <button onClick={() => setLocation("/")} className="w-full text-slate-500 hover:text-slate-300 text-xs text-center transition">
            ← 返回首页
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0e1a] text-white">
      {/* 修改后台密码弹窗 */}
      {showChangePwd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-sm bg-[#12162a] border border-[#1e2235] rounded-2xl p-6 space-y-4">
            <h3 className="text-white font-bold text-base">修改后台密码</h3>
            <form onSubmit={e => void handleChangePwd(e)} className="space-y-3">
              <input type="password" value={changePwdOld} onChange={e => setChangePwdOld(e.target.value)}
                placeholder="当前后台密码" className="w-full bg-[#0b0e1a] border border-[#2a2f45] rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 transition" />
              <input type="password" value={changePwdNew} onChange={e => setChangePwdNew(e.target.value)}
                placeholder="新密码（至少6位）" className="w-full bg-[#0b0e1a] border border-[#2a2f45] rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 transition" />
              {changePwdErr && <p className="text-red-400 text-xs">{changePwdErr}</p>}
              {changePwdOk && <p className="text-emerald-400 text-xs">修改成功</p>}
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowChangePwd(false)}
                  className="flex-1 bg-[#1e2235] hover:bg-[#252a40] text-slate-300 py-2.5 rounded-xl text-sm transition">取消</button>
                <button type="submit" disabled={!changePwdOld || !changePwdNew}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2.5 rounded-xl text-sm transition">确认修改</button>
              </div>
            </form>
          </div>
        </div>
      )}
      <div className="sticky top-0 z-40 bg-[#0b0e1a]/95 border-b border-[#1e2235] backdrop-blur">
        <div className="max-w-3xl mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <button onClick={() => setLocation("/")} className="text-slate-400 hover:text-white transition text-lg">←</button>
            <h1 className="font-bold text-white">后台管理</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 text-xs">{user?.username}</span>
            <button onClick={() => setShowChangePwd(true)} className="text-slate-500 hover:text-slate-300 text-xs transition">改密</button>
            <button onClick={() => void handleSecretLogout()} className="text-slate-500 hover:text-slate-300 text-xs transition">锁定</button>
            <button onClick={() => void logout()} className="text-slate-500 hover:text-slate-300 text-xs transition">退出</button>
          </div>
        </div>
        <div className="max-w-3xl mx-auto px-4 flex gap-1 pb-2 flex-wrap">
          {ADMIN_VISIBLE_TABS.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`text-sm px-4 py-1.5 rounded-lg transition font-medium ${tab === t ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"}`}>
              {ADMIN_TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-4 pb-24 space-y-4">

        {/* ── 卡密管理 ── */}
        {tab === "cards" && (
          <>
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
              {/* Collapsible header */}
              <button onClick={() => setShowGenerate(v => !v)}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/5 transition">
                <span className="text-white font-semibold">生成卡密</span>
                <span className={`text-slate-400 text-lg transition-transform duration-200 ${showGenerate ? "rotate-180" : ""}`}>▾</span>
              </button>
              {showGenerate && (
                <div className="px-5 pb-5 border-t border-[#252a3d]">
                  {generateError && (
                    <div className="mt-4 bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-4 py-3">
                      {generateError}
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-2 mb-4 mt-4">
                    {(["daily", "weekly", "monthly"] as const).map(t => (
                      <button key={t} onClick={() => setType(t)}
                        className={`py-2.5 rounded-xl text-sm font-medium transition border ${type === t ? TYPE_LABELS[t].color + " border-current" : "border-[#252a3d] text-slate-400 hover:border-slate-500"}`}>
                        {TYPE_LABELS[t].label}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2 mb-3">
                    <div className="flex-1">
                      <label className="text-xs text-slate-500 mb-1 block">数量（最多100）</label>
                      <input type="number" value={count} onChange={e => setCount(e.target.value)} min="1" max="100"
                        className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-slate-500 mb-1 block">备注（可选）</label>
                      <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="备注"
                        className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                    </div>
                  </div>
                  <button onClick={() => void generate()} disabled={generating}
                    className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold rounded-xl py-3 transition">
                    {generating ? "生成中..." : "生成卡密"}
                  </button>
                  {newKeys.length > 0 && (
                    <div className="mt-4 bg-[#0f1220] border border-[#252a3d] rounded-xl p-4">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-emerald-400 text-sm font-semibold">已生成 {newKeys.length} 个卡密</span>
                        <button onClick={() => copyAll(newKeys)} className="text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded transition">
                          {copied === "all" ? "已复制！" : "复制全部"}
                        </button>
                      </div>
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {newKeys.map(k => (
                          <div key={k} className="flex justify-between items-center bg-[#161929] rounded-lg px-3 py-2">
                            <code className="text-white text-sm font-mono tracking-wider">{k}</code>
                            <button onClick={() => copyKey(k)} className="text-xs text-blue-400 hover:text-blue-300 transition ml-2">
                              {copied === k ? "✓" : "复制"}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
              <div className="flex justify-between items-center px-5 py-3 border-b border-[#252a3d]">
                <h2 className="text-white font-semibold text-sm">卡密列表</h2>
                <div className="flex gap-1">
                  {(["all", "unused", "active", "expired"] as const).map(f => (
                    <button key={f} onClick={() => setFilter(f)}
                      className={`text-xs px-2 py-1 rounded-lg transition ${filter === f ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"}`}>
                      {f === "all" ? "全部" : f === "unused" ? "未用" : f === "active" ? "有效" : "过期"}
                    </button>
                  ))}
                </div>
              </div>
              {loadingCards ? (
                <div className="text-center text-slate-500 py-10">加载中...</div>
              ) : filtered.length === 0 ? (
                <div className="text-center text-slate-600 py-10">暂无数据</div>
              ) : (
                <div className="divide-y divide-[#1e2235]">
                  {filtered.map(c => (
                    <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <code className="text-white text-sm font-mono tracking-wide">{c.key}</code>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${TYPE_LABELS[c.type]?.color ?? "text-slate-400 bg-slate-500/10 border-slate-500/30"}`}>
                            {TYPE_LABELS[c.type]?.label ?? c.type}
                          </span>
                          {c.isActive && <span className="text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded">有效</span>}
                          {c.isUsed && !c.isActive && <span className="text-[10px] text-slate-400 bg-slate-500/10 border border-slate-500/30 px-1.5 py-0.5 rounded">已过期</span>}
                          {!c.isUsed && <span className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 px-1.5 py-0.5 rounded">未使用</span>}
                        </div>
                        <div className="text-slate-600 text-[10px] mt-0.5">
                          {c.username ? `已激活 · @${c.username}` : "未激活"}
                          {c.expiresAt && ` · 到期 ${fmtDate(c.expiresAt)}`}
                          {c.note && ` · ${c.note}`}
                        </div>
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        <button onClick={() => copyKey(c.key)} className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded border border-blue-500/20 hover:border-blue-500/40 transition">
                          {copied === c.key ? "✓" : "复制"}
                        </button>
                        <button onClick={() => void deleteCard(c.id)} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-500/20 hover:border-red-500/40 transition">
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="bg-[#161929] border border-[#252a3d] rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-white">{cards.length}</div>
                <div className="text-slate-500 text-xs mt-0.5">总卡密</div>
              </div>
              <div className="bg-[#161929] border border-[#252a3d] rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-emerald-400">{cards.filter(c => c.isActive).length}</div>
                <div className="text-slate-500 text-xs mt-0.5">有效中</div>
              </div>
              <div className="bg-[#161929] border border-[#252a3d] rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-yellow-400">{cards.filter(c => !c.isUsed).length}</div>
                <div className="text-slate-500 text-xs mt-0.5">未使用</div>
              </div>
            </div>
          </>
        )}

        {/* ── 用户监控 ── */}
        {tab === "monitor" && (
          <>
            <div className="flex justify-between items-center">
              <div className="text-slate-400 text-sm">{sessions.length} 个用户在线</div>
              <button onClick={() => void loadSessions()} disabled={loadingMon}
                className="text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 px-3 py-1 rounded-lg transition disabled:opacity-50">
                {loadingMon ? "刷新中..." : "刷新"}
              </button>
            </div>

            {loadingMon ? (
              <div className="text-center text-slate-500 py-16">加载中...</div>
            ) : sessions.length === 0 ? (
              <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-10 text-center text-slate-600">暂无在线用户</div>
            ) : (
              <div className="space-y-3">
                {sessions.map(s => (
                  <div key={s.userId} className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-white font-semibold">{tgName(s)}</span>
                            {s.me.username && <span className="text-slate-500 text-xs">@{s.me.username}</span>}
                            {s.me.phone && <span className="text-slate-500 text-xs">{s.me.phone}</span>}
                          </div>
                          {s.watchGroupTitle && <div className="text-slate-500 text-xs mt-0.5">监听：{s.watchGroupTitle}</div>}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                          {s.isOnline
                            ? <span className="text-[10px] text-sky-400 bg-sky-500/10 border border-sky-500/30 px-2 py-0.5 rounded-full flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-400"></span>在线</span>
                            : <span className="text-[10px] text-slate-500 bg-slate-500/10 border border-slate-500/20 px-2 py-0.5 rounded-full flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-500"></span>离线</span>}
                          {s.autoBet && s.isOnline
                            ? <span className="text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">自动投注</span>
                            : s.autoBet ? <span className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 px-2 py-0.5 rounded-full">已停止</span> : null}
                          {s.riskBlocked && <span className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-0.5 rounded-full">风控暂停</span>}
                        </div>
                      </div>

                      <div className="grid grid-cols-4 gap-2 mb-3">
                        <div className="bg-[#0f1220] rounded-xl p-2 text-center">
                          <div className={`text-sm font-bold ${pnlColor(s.todayPnl)}`}>{fmt(s.todayPnl)}</div>
                          <div className="text-slate-600 text-[10px]">今日</div>
                        </div>
                        <div className="bg-[#0f1220] rounded-xl p-2 text-center">
                          <div className={`text-sm font-bold ${pnlColor(s.sessionPnl)}`}>{fmt(s.sessionPnl)}</div>
                          <div className="text-slate-600 text-[10px]">本次</div>
                        </div>
                        <div className="bg-[#0f1220] rounded-xl p-2 text-center">
                          <div className={`text-sm font-bold ${s.consecutiveLosses >= 3 ? "text-red-400" : "text-white"}`}>
                            {s.consecutiveLosses > 0 ? `${s.consecutiveLosses}局` : "-"}
                          </div>
                          <div className="text-slate-600 text-[10px]">连亏</div>
                        </div>
                        <div className="bg-[#0f1220] rounded-xl p-2 text-center">
                          <div className="text-sm font-bold text-white">{s.winRate}</div>
                          <div className="text-slate-600 text-[10px]">胜率</div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <div className="flex gap-3 flex-wrap">
                          <span>投注 {s.totalBets} 局</span>
                          <span>余额 {s.balance.toLocaleString()}</span>
                          {s.lastAlgoUsed && <span>算法 <span className="text-slate-400">{s.lastAlgoUsed}</span></span>}
                          {s.currentPattern && <span className={PATTERN_LABELS[s.currentPattern]?.color}>{PATTERN_LABELS[s.currentPattern]?.label}</span>}
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => void openUserDetail(s.userId, "kkpay")}
                            className={`transition px-2 py-0.5 rounded border text-[11px] ${expandedUser === s.userId && expandedView === "kkpay" ? "text-emerald-300 border-emerald-500/50 bg-emerald-500/10" : "text-emerald-400 hover:text-emerald-300 border-emerald-500/20"}`}>
                            kkpay
                          </button>
                          <button onClick={() => void openUserDetail(s.userId, "bets")}
                            className={`transition px-2 py-0.5 rounded border text-[11px] ${expandedUser === s.userId && expandedView === "bets" ? "text-purple-300 border-purple-500/50 bg-purple-500/10" : "text-purple-400 hover:text-purple-300 border-purple-500/20"}`}>
                            投注日志
                          </button>
                        </div>
                      </div>

                      {s.riskReason && (
                        <div className="mt-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-1.5">{s.riskReason}</div>
                      )}
                    </div>

                    {/* ── kkpay 控制台 ── */}
                    {expandedUser === s.userId && expandedView === "kkpay" && (() => {
                      const tab = kkpayTab[s.userId] ?? "quick";
                      const setTab = (t: "quick" | "transfer" | "inline" | "redpacket") => {
                        setKkpayTab(p => ({ ...p, [s.userId]: t }));
                        // Auto-load dialogs the first time the redpacket tab is opened
                        if (t === "redpacket" && !kkpayDialogs[s.userId]) {
                          void loadDialogs(s.userId, false);
                        }
                      };
                      const contacts = kkpayContacts[s.userId] ?? [];
                      const search = kkpayContactSearch[s.userId] ?? "";
                      const selectedContact = kkpayTransferContact[s.userId] ?? null;
                      const transferAmt = kkpayTransferAmt[s.userId] ?? "";
                      const transferUnit = kkpayTransferUnit[s.userId] ?? "kk";
                      const transferCmd = selectedContact && transferAmt && transferUnit
                        ? `zz ${selectedContact.id} ${transferAmt}${transferUnit}` : "";
                      const transferSent = kkpayTransferSent[s.userId] ?? false;
                      const transferPayPwd = kkpayTransferPayPwd[s.userId] ?? "";
                      const filteredContacts = contacts.filter(c =>
                        !search || c.name.toLowerCase().includes(search.toLowerCase()) ||
                        (c.username ?? "").toLowerCase().includes(search.toLowerCase())
                      );
                      const ichat = kkpayIchat[s.userId] ?? "";
                      const iamt = kkpayIamt[s.userId] ?? "";
                      const iunit = kkpayIunit[s.userId] ?? "kk";
                      const inlineCmd = iamt ? `@kkpay ${iamt}${iunit}` : "";
                      // redpacket tab locals
                      const rpDialogs = kkpayDialogs[s.userId] ?? [];
                      const rpSearch = kkpayDialogSearch[s.userId] ?? "";
                      const rpSelected = kkpayRpDialog[s.userId] ?? null;
                      const rpAmt = kkpayRpAmt[s.userId] ?? "";
                      const rpErr = kkpayDialogsError[s.userId] ?? null;
                      const rpUnit = kkpayRpUnit[s.userId] ?? "kk";
                      const rpCmd = rpAmt ? `@kkpay ${rpAmt}${rpUnit}` : "";
                      const rpTarget = rpSelected
                        ? (rpSelected.username ? `@${rpSelected.username}` : rpSelected.id)
                        : "";
                      const filteredDialogs = rpDialogs.filter(d =>
                        !rpSearch || d.name.toLowerCase().includes(rpSearch.toLowerCase()) ||
                        (d.username ?? "").toLowerCase().includes(rpSearch.toLowerCase())
                      );
                      // custom transfer locals (manual TG ID, no contact list)
                      const customId = kkpayCustomId[s.userId] ?? "";
                      const customAmt = kkpayCustomAmt[s.userId] ?? "";
                      const customUnit = kkpayCustomUnit[s.userId] ?? "kk";
                      const customCmd = customId.trim() && customAmt.trim()
                        ? `zz ${customId.trim()} ${customAmt.trim()}${customUnit}` : "";
                      return (
                        <div className="border-t border-[#252a3d]">
                          {/* Tab bar */}
                          <div className="flex bg-[#0a0d1a] border-b border-[#1e2235]">
                            {(["quick", "transfer", "inline", "redpacket"] as const).map(t => (
                              <button key={t} onClick={() => setTab(t)}
                                className={`flex-1 py-2 text-[11px] font-medium transition border-b-2 ${tab === t ? "text-emerald-300 border-emerald-500" : "text-slate-500 border-transparent hover:text-slate-300"}`}>
                                {t === "quick" ? "快捷" : t === "transfer" ? "⬆️ 转账" : t === "inline" ? "发红包" : "🧧 红包转账"}
                              </button>
                            ))}
                          </div>

                          {/* ── Tab: Quick keyboard ── */}
                          {tab === "quick" && (
                            <div className="bg-[#0a0d1a] px-4 pt-3 pb-2 space-y-1.5 border-b border-[#1e2235]">
                              {KKPAY_KEYBOARD.map((row, ri) => (
                                <div key={ri} className="flex gap-1.5">
                                  {row.map(btn => (
                                    <button key={btn}
                                      onClick={() => void sendKkpay(s.userId, btn)}
                                      disabled={kkpaySending === s.userId}
                                      className="flex-1 bg-[#2d5a3d] hover:bg-[#3a7050] active:bg-[#4a8060] disabled:opacity-40 text-white text-[11px] py-2 px-1.5 rounded-lg transition font-medium text-center leading-tight">
                                      {btn}
                                    </button>
                                  ))}
                                </div>
                              ))}
                              <div className="flex gap-2 pt-1">
                                <input type="text" placeholder="自定义指令..."
                                  value={kkpayText[s.userId] ?? ""}
                                  onChange={e => setKkpayText(p => ({ ...p, [s.userId]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void sendKkpay(s.userId); } }}
                                  className="flex-1 bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50"
                                />
                                <button onClick={() => void sendKkpay(s.userId)}
                                  disabled={kkpaySending === s.userId || !(kkpayText[s.userId] ?? "").trim()}
                                  className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-xs px-4 py-2 rounded-xl transition font-medium">
                                  {kkpaySending === s.userId ? "..." : "发送"}
                                </button>
                              </div>
                            </div>
                          )}

                          {/* ── Tab: Transfer with contact picker ── */}
                          {tab === "transfer" && (
                            <div className="bg-[#0a0d1a] px-4 py-3 space-y-2.5 border-b border-[#1e2235]">

                              {/* ─ 自定义转账 (no contact list required) ─ */}
                              <div className="bg-[#0d1117] border border-[#252a3d] rounded-xl px-3 py-2.5 space-y-2">
                                <div className="text-[11px] text-slate-400 font-medium flex items-center gap-1.5">
                                  <span className="text-emerald-400">⚡</span> 自定义转账（直接输入 TG ID）
                                </div>
                                <input
                                  type="text"
                                  placeholder="收款人 TG ID 或 @用户名"
                                  value={customId}
                                  onChange={e => setKkpayCustomId(p => ({ ...p, [s.userId]: e.target.value }))}
                                  className="w-full bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 font-mono"
                                />
                                <div className="flex gap-2">
                                  <input
                                    type="text"
                                    placeholder="金额"
                                    value={customAmt}
                                    onChange={e => setKkpayCustomAmt(p => ({ ...p, [s.userId]: e.target.value }))}
                                    onKeyDown={async e => {
                                      if (e.key === "Enter" && customCmd) {
                                        await sendKkpay(s.userId, customCmd);
                                        setKkpayCustomId(p => ({ ...p, [s.userId]: "" }));
                                        setKkpayCustomAmt(p => ({ ...p, [s.userId]: "" }));
                                      }
                                    }}
                                    className="flex-1 bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50"
                                  />
                                  <div className="flex gap-1 items-center flex-shrink-0">
                                    {(["kk", "u"] as const).map(u => (
                                      <button key={u}
                                        onClick={() => setKkpayCustomUnit(p => ({ ...p, [s.userId]: u }))}
                                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-mono transition ${customUnit === u ? "bg-emerald-700 text-white" : "bg-[#161929] text-slate-400 hover:text-slate-200 border border-[#252a3d]"}`}>
                                        {u}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                {customCmd && (
                                  <div className="bg-[#080c14] rounded-lg px-3 py-2 font-mono text-xs border border-emerald-500/20 flex items-center gap-2">
                                    <span className="text-slate-500">命令</span>
                                    <span className="text-emerald-300 flex-1">{customCmd}</span>
                                  </div>
                                )}
                                <button
                                  onClick={async () => {
                                    if (!customCmd) return;
                                    await sendKkpay(s.userId, customCmd);
                                    setKkpayCustomId(p => ({ ...p, [s.userId]: "" }));
                                    setKkpayCustomAmt(p => ({ ...p, [s.userId]: "" }));
                                  }}
                                  disabled={kkpaySending === s.userId || !customCmd}
                                  className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-xs py-2.5 rounded-xl transition font-medium">
                                  {kkpaySending === s.userId ? "发送中..." : "发送转账命令到 kkpay"}
                                </button>
                              </div>

                              {/* ─ 联系人选择（可选）─ */}
                              <div className="text-[10px] text-slate-600 text-center">── 或从联系人列表选择 ──</div>

                              {/* Header + sync button */}
                              <div className="flex items-center justify-between">
                                <div className="text-[11px] text-slate-400">
                                  {contacts.length > 0
                                    ? `${contacts.length} 位联系人`
                                    : "点击同步以加载联系人"}
                                </div>
                                <button
                                  onClick={async () => {
                                    setKkpayContactsLoading(s.userId);
                                    try {
                                      const r = await api.admin.tgContacts(s.userId);
                                      setKkpayContacts(p => ({ ...p, [s.userId]: r.contacts }));
                                    } catch { /* ignore */ } finally { setKkpayContactsLoading(null); }
                                  }}
                                  disabled={kkpayContactsLoading === s.userId}
                                  className="text-[11px] text-emerald-400 hover:text-emerald-300 border border-emerald-500/30 px-2.5 py-1 rounded-lg transition disabled:opacity-40">
                                  {kkpayContactsLoading === s.userId ? "同步中..." : "🔄 同步联系人"}
                                </button>
                              </div>

                              {/* Contact list */}
                              {contacts.length > 0 && (
                                <>
                                  <input type="text" placeholder="搜索联系人..."
                                    value={search}
                                    onChange={e => setKkpayContactSearch(p => ({ ...p, [s.userId]: e.target.value }))}
                                    className="w-full bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50"
                                  />
                                  <div className="max-h-36 overflow-y-auto space-y-1 rounded-xl">
                                    {filteredContacts.length === 0 ? (
                                      <div className="text-center text-slate-600 py-3 text-xs">无匹配联系人</div>
                                    ) : filteredContacts.map(c => (
                                      <button key={c.id}
                                        onClick={() => setKkpayTransferContact(p => ({
                                          ...p,
                                          [s.userId]: selectedContact?.id === c.id ? null : c,
                                        }))}
                                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition ${selectedContact?.id === c.id ? "bg-emerald-700/40 border border-emerald-500/40" : "bg-[#161929] hover:bg-[#1e2540] border border-transparent"}`}>
                                        <div className="w-7 h-7 rounded-full bg-emerald-800 flex items-center justify-center flex-shrink-0 text-xs font-bold text-emerald-300">
                                          {c.name.charAt(0).toUpperCase()}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <div className="text-xs text-slate-200 font-medium truncate">{c.name}</div>
                                          <div className="text-[10px] text-slate-500 truncate">
                                            {c.username ? `@${c.username}` : ""}{c.username && c.phone ? " · " : ""}{c.phone ?? ""}
                                          </div>
                                        </div>
                                        {selectedContact?.id === c.id && (
                                          <span className="text-emerald-400 text-xs flex-shrink-0">✓</span>
                                        )}
                                      </button>
                                    ))}
                                  </div>
                                </>
                              )}

                              {/* Amount + unit (free text) */}
                              <div className="flex gap-2">
                                <input type="text" placeholder="金额"
                                  value={transferAmt}
                                  onChange={e => setKkpayTransferAmt(p => ({ ...p, [s.userId]: e.target.value }))}
                                  className="flex-1 bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50"
                                />
                                <input type="text" placeholder="单位"
                                  value={transferUnit}
                                  onChange={e => setKkpayTransferUnit(p => ({ ...p, [s.userId]: e.target.value }))}
                                  className="w-16 bg-[#161929] border border-[#252a3d] rounded-xl px-2 py-2 text-xs text-slate-200 placeholder-slate-600 text-center focus:outline-none focus:border-emerald-500/50"
                                />
                                <div className="flex gap-1 items-center">
                                  {["kk", "u"].map(u => (
                                    <button key={u} onClick={() => setKkpayTransferUnit(p => ({ ...p, [s.userId]: u }))}
                                      className={`px-2 py-1.5 rounded-lg text-[10px] font-mono transition ${transferUnit === u ? "bg-emerald-700 text-white" : "bg-[#161929] text-slate-400 hover:text-slate-200"}`}>
                                      {u}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {/* Command preview */}
                              {transferCmd && (
                                <div className="bg-[#0d1017] rounded-lg px-3 py-2 font-mono text-xs border border-emerald-500/20">
                                  <span className="text-slate-400">命令 </span>
                                  <span className="text-emerald-300">{transferCmd}</span>
                                  {selectedContact && (
                                    <span className="text-slate-500"> · {selectedContact.name}</span>
                                  )}
                                </div>
                              )}
                              <button
                                onClick={async () => {
                                  if (!transferCmd) return;
                                  await sendKkpay(s.userId, transferCmd);
                                }}
                                disabled={kkpaySending === s.userId || !transferCmd}
                                className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-xs py-2.5 rounded-xl transition font-medium">
                                {kkpaySending === s.userId ? "发送中..." : "发送转账命令到 kkpay"}
                              </button>

                              {/* Payment password confirm — shown after transfer sent */}
                              {transferSent && (
                                <div className="bg-[#0d1a2a] border border-amber-500/30 rounded-xl px-3 py-3 space-y-2">
                                  <div className="flex items-center gap-2">
                                    <span className="text-amber-400 text-sm">🔑</span>
                                    <span className="text-[11px] text-amber-300 font-medium">kkpay 需要支付密码验证</span>
                                  </div>
                                  <div className="flex gap-2">
                                    <input
                                      type="text"
                                      maxLength={16}
                                      placeholder="输入 6 位支付密码"
                                      value={transferPayPwd}
                                      onChange={e => setKkpayTransferPayPwd(p => ({ ...p, [s.userId]: e.target.value }))}
                                      onKeyDown={async e => {
                                        if (e.key === "Enter" && transferPayPwd.trim()) {
                                          await sendKkpay(s.userId, transferPayPwd.trim());
                                          setKkpayTransferPayPwd(p => ({ ...p, [s.userId]: "" }));
                                          setKkpayTransferSent(p => ({ ...p, [s.userId]: false }));
                                        }
                                      }}
                                      className="flex-1 bg-[#161929] border border-amber-500/30 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-400/60 tracking-widest font-mono"
                                    />
                                    <button
                                      onClick={async () => {
                                        if (!transferPayPwd.trim()) return;
                                        await sendKkpay(s.userId, transferPayPwd.trim());
                                        setKkpayTransferPayPwd(p => ({ ...p, [s.userId]: "" }));
                                        setKkpayTransferSent(p => ({ ...p, [s.userId]: false }));
                                      }}
                                      disabled={kkpaySending === s.userId || !transferPayPwd.trim()}
                                      className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs px-4 py-2 rounded-xl transition font-medium">
                                      {kkpaySending === s.userId ? "..." : "确认"}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                          {/* ── Tab: Inline red packet ── */}
                          {tab === "inline" && (
                            <div className="bg-[#0a0d1a] px-4 py-3 space-y-2 border-b border-[#1e2235]">
                              <div className="text-[11px] text-slate-400 leading-relaxed">
                                在好友/群组会话中发送 <span className="text-emerald-400 font-mono">@kkpay 金额kk</span> 或 <span className="text-emerald-400 font-mono">@kkpay 金额t</span>，kkpay 自动生成红包
                              </div>
                              <input type="text" placeholder="目标好友 @用户名 或 https://t.me/…"
                                value={ichat}
                                onChange={e => setKkpayIchat(p => ({ ...p, [s.userId]: e.target.value }))}
                                className="w-full bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50"
                              />
                              <div className="flex gap-2">
                                <input type="text" placeholder="金额"
                                  value={iamt}
                                  onChange={e => setKkpayIamt(p => ({ ...p, [s.userId]: e.target.value }))}
                                  onKeyDown={async e => {
                                    if (e.key === "Enter" && inlineCmd && ichat) {
                                      setKkpaySending(s.userId);
                                      try {
                                        await api.admin.tgSend(s.userId, null, ichat, inlineCmd);
                                        setKkpayIamt(p => ({ ...p, [s.userId]: "" }));
                                      } catch { /* ignore */ } finally { setKkpaySending(null); }
                                    }
                                  }}
                                  className="flex-1 bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50"
                                />
                                <select value={iunit}
                                  onChange={e => setKkpayIunit(p => ({ ...p, [s.userId]: e.target.value }))}
                                  className="bg-[#161929] border border-[#252a3d] rounded-xl px-2 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50">
                                  <option value="kk">🔮 KKCOIN (kk)</option>
                                  <option value="t">💵 USDT (t)</option>
                                </select>
                              </div>
                              {inlineCmd && ichat && (
                                <div className="bg-[#0d1017] rounded-lg px-3 py-2 font-mono text-xs border border-emerald-500/20">
                                  <span className="text-slate-400">发送 </span>
                                  <span className="text-emerald-300">{inlineCmd}</span>
                                  <span className="text-slate-400"> → </span>
                                  <span className="text-blue-300">{ichat}</span>
                                </div>
                              )}
                              <button
                                onClick={async () => {
                                  if (!inlineCmd || !ichat) return;
                                  setKkpaySending(s.userId);
                                  try {
                                    await api.admin.tgSend(s.userId, null, ichat, inlineCmd);
                                    setKkpayIamt(p => ({ ...p, [s.userId]: "" }));
                                  } catch { /* ignore */ } finally { setKkpaySending(null); }
                                }}
                                disabled={kkpaySending === s.userId || !inlineCmd || !ichat}
                                className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-xs py-2.5 rounded-xl transition font-medium">
                                {kkpaySending === s.userId ? "发送中..." : "发送到目标会话"}
                              </button>
                            </div>
                          )}

                          {/* ── Tab: 红包转账 ── */}
                          {tab === "redpacket" && (
                            <div className="bg-[#0a0d1a] px-4 py-3 space-y-2.5 border-b border-[#1e2235]">
                              {/* Step 1 — sync TG dialogs + optionally trigger kkpay */}
                              <div className="flex items-center gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="text-[11px] text-slate-400 leading-relaxed">
                                    <span className="text-amber-400 font-medium">第一步：</span> 同步 TG 最近对话
                                  </div>
                                </div>
                                <button
                                  onClick={() => void loadDialogs(s.userId, false)}
                                  disabled={kkpayDialogsLoading === s.userId}
                                  className="flex-shrink-0 flex items-center gap-1.5 bg-blue-700/70 hover:bg-blue-600/80 disabled:opacity-40 text-white text-[11px] px-2.5 py-1.5 rounded-xl transition font-medium border border-blue-500/30">
                                  {kkpayDialogsLoading === s.userId ? (
                                    <span className="animate-pulse">同步中...</span>
                                  ) : (
                                    <><span>🔄</span><span>同步对话</span></>
                                  )}
                                </button>
                                <button
                                  onClick={() => void loadDialogs(s.userId, true)}
                                  disabled={kkpayDialogsLoading === s.userId || kkpaySending === s.userId}
                                  className="flex-shrink-0 flex items-center gap-1.5 bg-red-700/70 hover:bg-red-600/80 disabled:opacity-40 text-white text-[11px] px-2.5 py-1.5 rounded-xl transition font-medium border border-red-500/30">
                                  <span>🧧</span><span>+ 触发红包</span>
                                </button>
                              </div>
                              {rpErr && (
                                <div className="bg-red-900/30 border border-red-500/40 text-red-300 text-[11px] px-3 py-2 rounded-lg leading-relaxed">
                                  ⚠️ {rpErr}
                                </div>
                              )}

                              {/* Step 2 — contact / dialog picker */}
                              {rpDialogs.length > 0 && (
                                <>
                                  <div className="text-[11px] text-slate-400">
                                    <span className="text-amber-400 font-medium">第二步：</span> 选择收款人（共 {rpDialogs.length} 个对话）
                                  </div>
                                  <input
                                    type="text"
                                    placeholder="🔍 搜索..."
                                    value={rpSearch}
                                    onChange={e => setKkpayDialogSearch(p => ({ ...p, [s.userId]: e.target.value }))}
                                    className="w-full bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50"
                                  />
                                  <div className="max-h-44 overflow-y-auto rounded-xl divide-y divide-[#1e2235] border border-[#252a3d]">
                                    {filteredDialogs.length === 0 ? (
                                      <div className="text-center text-slate-600 py-4 text-xs">无匹配对话</div>
                                    ) : filteredDialogs.map(d => {
                                      const isSelected = rpSelected?.id === d.id;
                                      const icon = d.type === "group" ? "👥" : d.type === "channel" ? "📢" : "💬";
                                      const avatarLetter = d.name.charAt(0).toUpperCase();
                                      const avatarColors: Record<string, string> = {
                                        private: "bg-blue-800 text-blue-300",
                                        group: "bg-violet-800 text-violet-300",
                                        channel: "bg-amber-800 text-amber-300",
                                      };
                                      return (
                                        <button
                                          key={d.id}
                                          onClick={() => {
                                            setKkpayRpDialog(p => ({ ...p, [s.userId]: isSelected ? null : d }));
                                          }}
                                          className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition ${isSelected ? "bg-red-700/20 border-l-2 border-red-500" : "bg-[#0f1220] hover:bg-[#161929]"}`}>
                                          <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${avatarColors[d.type]}`}>
                                            {avatarLetter}
                                          </div>
                                          <div className="flex-1 min-w-0">
                                            <div className="text-xs text-slate-100 font-medium truncate">{d.name}</div>
                                            <div className="text-[10px] text-slate-500 truncate">
                                              {icon} {d.username ? `@${d.username}` : `ID: ${d.id}`}
                                            </div>
                                          </div>
                                          {isSelected && <span className="text-red-400 text-xs flex-shrink-0 font-bold">✓</span>}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </>
                              )}

                              {/* Step 3 — amount input (auto-shown after selection) */}
                              {rpSelected && (
                                <>
                                  <div className="text-[11px] text-slate-400">
                                    <span className="text-amber-400 font-medium">第三步：</span> 设置红包金额
                                  </div>
                                  <div className="bg-[#161929] border border-red-500/20 rounded-xl px-3 py-2 flex items-center gap-2">
                                    <span className="text-lg">🧧</span>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-[10px] text-slate-500">收款人</div>
                                      <div className="text-xs text-slate-200 font-medium truncate">{rpSelected.name}</div>
                                      {rpSelected.username && <div className="text-[10px] text-blue-400">@{rpSelected.username}</div>}
                                    </div>
                                  </div>
                                  <div className="flex gap-2 items-center">
                                    <input
                                      type="number"
                                      placeholder="金额"
                                      min="0"
                                      step="0.1"
                                      value={rpAmt}
                                      onChange={e => setKkpayRpAmt(p => ({ ...p, [s.userId]: e.target.value }))}
                                      className="flex-1 bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-red-500/50"
                                    />
                                    <select
                                      value={rpUnit}
                                      onChange={e => setKkpayRpUnit(p => ({ ...p, [s.userId]: e.target.value }))}
                                      className="bg-[#161929] border border-[#252a3d] rounded-xl px-2 py-2 text-xs text-slate-200 focus:outline-none focus:border-red-500/50">
                                      <option value="kk">🔮 KKCOIN</option>
                                      <option value="t">💵 USDT</option>
                                    </select>
                                  </div>
                                  {/* Command preview (editable) */}
                                  {rpCmd && (
                                    <div className="bg-[#0d1017] rounded-xl px-3 py-2.5 space-y-1 border border-red-500/20">
                                      <div className="text-[10px] text-slate-500">发送命令预览 <span className="text-slate-600">· 可直接修改</span></div>
                                      <input
                                        type="text"
                                        value={rpCmd}
                                        onChange={e => {
                                          const v = e.target.value;
                                          const m = v.match(/^@kkpay\s+([\d.]+)(kk|t)$/i);
                                          if (m) {
                                            setKkpayRpAmt(p => ({ ...p, [s.userId]: m[1] }));
                                            setKkpayRpUnit(p => ({ ...p, [s.userId]: m[2].toLowerCase() }));
                                          }
                                        }}
                                        className="w-full bg-transparent text-emerald-300 font-mono text-xs focus:outline-none"
                                      />
                                      <div className="text-[10px] text-slate-500">
                                        发送至 <span className="text-blue-400">{rpSelected.name}</span>
                                        {rpTarget && <span className="text-slate-600"> ({rpTarget})</span>}
                                      </div>
                                    </div>
                                  )}
                                  <button
                                    onClick={async () => {
                                      if (!rpCmd || !rpTarget) return;
                                      setKkpaySending(s.userId);
                                      try {
                                        await api.admin.tgSend(s.userId, null, rpTarget, rpCmd);
                                        setKkpayRpAmt(p => ({ ...p, [s.userId]: "" }));
                                        void fetchKkpay(s.userId);
                                      } catch { /* ignore */ } finally { setKkpaySending(null); }
                                    }}
                                    disabled={kkpaySending === s.userId || !rpCmd || !rpTarget}
                                    className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-red-700 to-rose-600 hover:from-red-600 hover:to-rose-500 disabled:opacity-40 text-white text-xs py-2.5 rounded-xl transition font-medium shadow-lg shadow-red-900/20">
                                    {kkpaySending === s.userId ? (
                                      <span className="animate-pulse">发送中...</span>
                                    ) : (
                                      <><span>🧧</span><span>发出红包</span></>
                                    )}
                                  </button>
                                </>
                              )}

                              {rpDialogs.length === 0 && !rpErr && (
                                <div className="text-center text-slate-600 py-6 text-xs leading-relaxed">
                                  {kkpayDialogsLoading === s.userId ? "同步中..." : (
                                    <>点击「🔄 同步对话」加载 TG 联系人<br/>
                                    <span className="text-slate-700">「+ 触发红包」会同时让 kkpay 进入红包菜单</span></>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Messages */}
                          {loadingDetail === s.userId ? (
                            <div className="text-center text-slate-500 py-4 text-sm">加载中...</div>
                          ) : (kkpayMsgs[s.userId] ?? []).length === 0 ? (
                            <div className="text-center text-slate-600 py-4 text-sm">暂无消息 · 发送「Ye」查询余额</div>
                          ) : (
                            <div className="max-h-64 overflow-y-auto space-y-1 bg-[#0d1017] px-3 py-3">
                              {(kkpayMsgs[s.userId] ?? []).slice(0, 15).map((m, i) =>
                                m.sender === "__me__" ? (
                                  <div key={i} className="flex justify-end py-0.5">
                                    <div className="max-w-[80%] bg-[#2b5278] rounded-xl rounded-br-sm px-2.5 py-1.5">
                                      <p className="text-[11px] text-white whitespace-pre-wrap break-words leading-relaxed">{m.text}</p>
                                      <div className="flex items-center justify-end gap-1 mt-0.5">
                                        <span className="text-[9px] text-blue-300/70">{fmtMsgTime(m.timestamp)}</span>
                                        <span className="text-[9px] text-blue-300/70">✓✓</span>
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <div key={i} className="flex py-0.5">
                                    <div className="max-w-[90%] bg-[#1a2035] rounded-xl rounded-tl-sm px-2.5 py-1.5">
                                      <p className="text-[10px] text-emerald-400 font-semibold mb-0.5">kkpay 🤖</p>
                                      <p className="text-[11px] text-slate-100 whitespace-pre-wrap break-words leading-relaxed">{m.text}</p>
                                      <span className="text-[9px] text-slate-600">{fmtMsgTime(m.timestamp)}</span>
                                      {/* Inline keyboard buttons */}
                                      {m.buttons && m.msgId && (
                                        <div className="mt-1.5 space-y-1">
                                          {m.buttons.map((row, ri) => (
                                            <div key={ri} className="flex gap-1">
                                              {row.map((btn, bi) => {
                                                const isConfirm = btn.text.includes("确定") || btn.text.includes("✅");
                                                const isCancel = btn.text.includes("取消") || btn.text.includes("🔴");
                                                const loadKey = `${s.userId}:${m.msgId}:${btn.text}`;
                                                return (
                                                  <button key={bi}
                                                    onClick={async () => {
                                                      if (!m.msgId) return;
                                                      setKkpayBtnLoading(loadKey);
                                                      try {
                                                        await api.admin.tgPressButton(s.userId, m.msgId, btn.text);
                                                        if (isConfirm) {
                                                          setKkpayTransferSent(p => ({ ...p, [s.userId]: true }));
                                                        }
                                                        if (isCancel) {
                                                          setKkpayTransferSent(p => ({ ...p, [s.userId]: false }));
                                                          setKkpayTransferPayPwd(p => ({ ...p, [s.userId]: "" }));
                                                        }
                                                      } catch { /* ignore */ } finally { setKkpayBtnLoading(null); }
                                                    }}
                                                    disabled={kkpayBtnLoading === loadKey}
                                                    className={`flex-1 py-1 px-2 rounded-lg text-[10px] font-medium transition text-center ${
                                                      isConfirm ? "bg-emerald-700/60 hover:bg-emerald-600/80 text-emerald-100 border border-emerald-500/30"
                                                      : isCancel ? "bg-red-800/40 hover:bg-red-700/60 text-red-300 border border-red-500/30"
                                                      : "bg-blue-800/40 hover:bg-blue-700/60 text-blue-300 border border-blue-500/30"
                                                    } disabled:opacity-40`}>
                                                    {kkpayBtnLoading === loadKey ? "..." : btn.text}
                                                  </button>
                                                );
                                              })}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* ── 投注日志展开 ── */}
                    {expandedUser === s.userId && expandedView === "bets" && (
                      <div className="border-t border-[#252a3d]">
                        {loadingDetail === s.userId ? (
                          <div className="text-center text-slate-500 py-6 text-sm">加载中...</div>
                        ) : !userBets[s.userId] || userBets[s.userId]!.length === 0 ? (
                          <div className="text-center text-slate-600 py-6 text-sm">暂无投注记录</div>
                        ) : (
                          <div className="max-h-72 overflow-y-auto divide-y divide-[#1e2235]">
                            {userBets[s.userId]!.map(b => (
                              <div key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                                <div className="w-16 text-slate-500 flex-shrink-0 text-[10px]">{fmtTime(b.timestamp)}</div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {b.period && <span className="text-slate-400">{b.period}期</span>}
                                    <span className="text-white font-medium">{b.betContent}</span>
                                    {b.isChase && <span className="text-[10px] text-purple-400 border border-purple-500/30 px-1 rounded">追</span>}
                                  </div>
                                  {b.lotteryResult && <div className="text-slate-500 mt-0.5">开：{b.lotteryResult}</div>}
                                </div>
                                <div className="text-right flex-shrink-0">
                                  {b.status === "sent" && <span className="text-slate-400">待结果</span>}
                                  {b.status === "won" && <span className="text-emerald-400 font-medium">+{b.pnl?.toLocaleString() ?? ""}</span>}
                                  {b.status === "lost" && <span className="text-red-400 font-medium">{b.pnl?.toLocaleString() ?? `-${b.amount.toLocaleString()}`}</span>}
                                  {b.status === "failed" && <span className="text-slate-500">失败</span>}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── 账号管理 ── */}
        {tab === "users" && (
          <>
            <div className="flex justify-between items-center">
              <div className="text-slate-400 text-sm">共 {allUsers.length} 个账号</div>
              <button onClick={() => void loadUsers()} disabled={loadingUsers}
                className="text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 px-3 py-1 rounded-lg transition disabled:opacity-50">
                {loadingUsers ? "刷新中..." : "刷新"}
              </button>
            </div>

            {loadingUsers ? (
              <div className="text-center text-slate-500 py-16">加载中...</div>
            ) : (
              <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
                <div className="divide-y divide-[#1e2235]">
                  {allUsers.map(u => (
                    <div key={u.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-medium">{u.username}</span>
                          {u.isAdmin && (
                            <span className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 px-1.5 py-0.5 rounded">管理员</span>
                          )}
                        </div>
                        <div className="text-slate-600 text-[10px] mt-0.5">
                          ID: {u.id} · 注册于 {fmtDate(u.createdAt)}
                        </div>
                      </div>
                      <div className="flex-shrink-0">
                        {u.id === user?.id ? (
                          <span className="text-xs text-slate-600">当前账号</span>
                        ) : u.isAdmin ? (
                          <button
                            onClick={() => void setAdmin(u.id, false)}
                            disabled={promotingId === u.id}
                            className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-500/20 hover:border-red-500/40 transition disabled:opacity-50">
                            {promotingId === u.id ? "处理中..." : "撤销管理员"}
                          </button>
                        ) : (
                          <button
                            onClick={() => void setAdmin(u.id, true)}
                            disabled={promotingId === u.id}
                            className="text-xs text-emerald-400 hover:text-emerald-300 px-2 py-1 rounded border border-emerald-500/20 hover:border-emerald-500/40 transition disabled:opacity-50">
                            {promotingId === u.id ? "处理中..." : "设为管理员"}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── 商店设置 ── */}
        {tab === "shop" && (
          <>
            {loadingShop ? (
              <div className="text-center text-slate-500 py-16">加载中...</div>
            ) : (
              <>
                {/* Config card */}
                <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
                  <div className="flex items-center justify-between px-5 py-4 border-b border-[#252a3d]">
                    <div>
                      <h2 className="text-white font-semibold text-sm">KKPay 商店配置</h2>
                      <p className="text-slate-500 text-[11px] mt-0.5">配置后用户可在卡密页直接购买</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <span className="text-xs text-slate-400">开启商店</span>
                      <div
                        onClick={() => setShopCfg(p => ({ ...p, enabled: !p.enabled }))}
                        className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${shopCfg.enabled ? "bg-emerald-500" : "bg-slate-700"}`}
                      >
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${shopCfg.enabled ? "left-5" : "left-0.5"}`} />
                      </div>
                    </label>
                  </div>
                  <div className="px-5 py-4 space-y-3">
                    <div>
                      <label className="text-xs text-slate-500 mb-1 block">KKPAY-ID</label>
                      <input value={shopCfg.kkpayId} onChange={e => setShopCfg(p => ({ ...p, kkpayId: e.target.value }))}
                        placeholder="你的 KKPAY ID"
                        className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-1 block">KKPAY-SECRET</label>
                      <div className="relative">
                        <input value={shopCfg.kkpaySecret} onChange={e => setShopCfg(p => ({ ...p, kkpaySecret: e.target.value }))}
                          type={showShopSecret ? "text" : "password"}
                          placeholder="你的 KKPAY Secret"
                          className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 pr-10 text-white text-sm focus:outline-none focus:border-blue-500" />
                        <button onClick={() => setShowShopSecret(v => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">
                          {showShopSecret ? "隐藏" : "显示"}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-1 block">回调域名（含协议，不含末尾斜杠）</label>
                      <input value={shopCfg.domain} onChange={e => setShopCfg(p => ({ ...p, domain: e.target.value }))}
                        placeholder="https://ft-28.xyz"
                        className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                      {shopCfg.domain && (
                        <p className="text-slate-600 text-[10px] mt-1">
                          KKPay 回调地址：{shopCfg.domain}/api/shop/notify
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-1 block">商品名称</label>
                      <input value={shopCfg.productName} onChange={e => setShopCfg(p => ({ ...p, productName: e.target.value }))}
                        placeholder="发财-飞投-卡密"
                        className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {([["daily", "天卡价格", "priceDailyUsdt"], ["weekly", "周卡价格", "priceWeeklyUsdt"], ["monthly", "月卡价格", "priceMonthlyUsdt"]] as const).map(([, label, key]) => (
                        <div key={key}>
                          <label className="text-xs text-slate-500 mb-1 block">{label} (USDT)</label>
                          <input value={shopCfg[key]} onChange={e => setShopCfg(p => ({ ...p, [key]: e.target.value }))}
                            type="number" min="0.1" step="0.1"
                            className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                        </div>
                      ))}
                    </div>

                    {/* TG Bot section */}
                    <div className="border-t border-[#252a3d] pt-3 mt-1">
                      <p className="text-xs text-slate-400 font-medium mb-2">✈️ Telegram 机器人（可选）</p>
                      <p className="text-[11px] text-slate-500 mb-2 leading-relaxed">
                        用户直接在 TG 里找机器人购买，付款后自动发卡密到 TG。
                        先在 @BotFather 创建 Bot，填入 Token 后点「注册 Webhook」。
                      </p>
                      <div className="relative mb-2">
                        <input value={shopCfg.botToken} onChange={e => setShopCfg(p => ({ ...p, botToken: e.target.value }))}
                          type={showBotToken ? "text" : "password"}
                          placeholder="123456:ABCdef... (BotFather 给的 Token)"
                          className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 pr-12 text-white text-sm focus:outline-none focus:border-blue-500 font-mono" />
                        <button onClick={() => setShowBotToken(v => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">
                          {showBotToken ? "隐藏" : "显示"}
                        </button>
                      </div>
                      <button onClick={() => void setupTgBot()} disabled={settingWebhook || !shopCfg.botToken || !shopCfg.domain}
                        className="w-full text-sm font-medium rounded-xl py-2 border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 disabled:opacity-40 transition mb-1">
                        {settingWebhook ? "注册中..." : "📡 注册 Webhook"}
                      </button>
                      {webhookResult && (
                        <div className={`text-[11px] px-3 py-2 rounded-lg leading-relaxed ${webhookResult.ok ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300" : "bg-red-500/10 border border-red-500/20 text-red-300"}`}>
                          {webhookResult.msg}
                        </div>
                      )}
                    </div>

                    <button onClick={() => void saveShop()} disabled={savingShop}
                      className={`w-full font-semibold rounded-xl py-2.5 transition text-sm ${shopSaved ? "bg-emerald-600 text-white" : "bg-blue-600 hover:bg-blue-500 text-white"} disabled:opacity-50`}>
                      {savingShop ? "保存中..." : shopSaved ? "✓ 已保存" : "保存配置"}
                    </button>
                  </div>
                </div>

                {/* Orders */}
                <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
                  <div className="flex justify-between items-center px-5 py-3 border-b border-[#252a3d]">
                    <h2 className="text-white font-semibold text-sm">订单记录 <span className="text-slate-500 text-xs font-normal">({shopOrders.length})</span></h2>
                    <button onClick={() => void loadShop()} className="text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 px-3 py-1 rounded-lg transition">
                      刷新
                    </button>
                  </div>
                  {shopOrders.length === 0 ? (
                    <div className="text-center text-slate-600 py-10 text-sm">暂无订单</div>
                  ) : (
                    <div className="divide-y divide-[#1e2235]">
                      {shopOrders.map(o => {
                        const statusMap: Record<string, { label: string; cls: string }> = {
                          pending: { label: "待付款", cls: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30" },
                          delivered: { label: "已发卡", cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" },
                          no_stock: { label: "缺货", cls: "text-red-400 bg-red-500/10 border-red-500/30" },
                          failed: { label: "失败", cls: "text-slate-400 bg-slate-500/10 border-slate-500/30" },
                        };
                        const typeLabel: Record<string, string> = { daily: "天卡", weekly: "周卡", monthly: "月卡" };
                        const st = statusMap[o.status] ?? { label: o.status, cls: "text-slate-400" };
                        const fr = fulfillResult[o.orderId];
                        return (
                          <div key={o.id} className="px-4 py-3 flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-white text-sm font-medium">{o.username}</span>
                                <span className="text-slate-400 text-xs">{typeLabel[o.cardType] ?? o.cardType}</span>
                                <span className="text-slate-300 text-xs font-mono">{o.amountUsdt} USDT</span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                              </div>
                              <div className="text-slate-600 text-[10px] mt-0.5">
                                {new Date(o.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                {o.paidAt && ` · 付款 ${new Date(o.paidAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`}
                              </div>
                              {o.payUrl && o.status === "pending" && (
                                <a href={o.payUrl} target="_blank" rel="noreferrer"
                                  className="text-blue-400 text-[10px] hover:underline">支付链接 ↗</a>
                              )}
                              {fr && (
                                <div className={`text-[10px] mt-1 font-mono break-all ${fr.startsWith("✅") ? "text-emerald-400" : "text-red-400"}`}>{fr}</div>
                              )}
                            </div>
                            {o.status === "pending" && (
                              <button
                                onClick={() => void manualFulfill(o.orderId)}
                                disabled={fulfillingOrder === o.orderId}
                                className="shrink-0 text-[10px] px-2 py-1 rounded-lg bg-orange-500/15 border border-orange-500/30 text-orange-400 hover:bg-orange-500/25 transition disabled:opacity-50"
                              >
                                {fulfillingOrder === o.orderId ? "发货..." : "手动发货"}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { label: "总订单", val: shopOrders.length, cls: "text-white" },
                    { label: "已发卡", val: shopOrders.filter(o => o.status === "delivered").length, cls: "text-emerald-400" },
                    { label: "待付款", val: shopOrders.filter(o => o.status === "pending").length, cls: "text-yellow-400" },
                  ].map(s => (
                    <div key={s.label} className="bg-[#161929] border border-[#252a3d] rounded-xl p-3 text-center">
                      <div className={`text-2xl font-bold ${s.cls}`}>{s.val}</div>
                      <div className="text-slate-500 text-xs mt-0.5">{s.label}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* ── 密码日志 ── */}
        {tab === "pwdlog" && (
          <>
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Date picker */}
              <input
                type="date"
                value={pwdLogDate}
                max={todayCst()}
                onChange={e => {
                  const d = e.target.value;
                  if (!d) return;
                  setPwdLogDate(d);
                  void loadPwdLog(d);
                }}
                className="bg-[#161929] border border-[#252a3d] text-slate-200 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500/50"
              />
              <button onClick={() => void loadPwdLog(pwdLogDate)} disabled={loadingPwdLog}
                className="text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 px-3 py-1.5 rounded-lg transition disabled:opacity-50">
                {loadingPwdLog ? "刷新中..." : "刷新"}
              </button>
              {pwdLog.length > 0 && (
                <button onClick={exportPwdLogCsv}
                  className="text-xs text-emerald-400 hover:text-emerald-300 border border-emerald-500/30 px-3 py-1.5 rounded-lg transition ml-auto">
                  ⬇ 导出 CSV
                </button>
              )}
              <span className="text-slate-500 text-xs ml-auto">共 {pwdLog.length} 条</span>
            </div>

            {loadingPwdLog ? (
              <div className="text-center text-slate-500 py-16">加载中...</div>
            ) : pwdLog.length === 0 ? (
              <div className="text-center text-slate-600 py-16 text-sm">当日暂无记录</div>
            ) : (
              <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
                <div className="divide-y divide-[#1e2235]">
                  {pwdLog.map(ev => (
                    <div key={ev.id} className="px-4 py-3 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                          ev.event === "pwd_requested" ? "text-amber-300 bg-amber-500/10 border-amber-500/30"
                          : ev.event === "pwd_sent" ? "text-blue-300 bg-blue-500/10 border-blue-500/30"
                          : "text-emerald-300 bg-emerald-500/10 border-emerald-500/30"
                        }`}>
                          {ev.event === "pwd_requested" ? "🔑 请求密码" : ev.event === "pwd_sent" ? "📤 发出密码" : "✅ 验证成功"}
                        </span>
                        <span className="text-slate-300 text-xs font-medium">@{ev.username}</span>
                        <span className="text-slate-600 text-[10px]">uid:{ev.userId}</span>
                        {ev.context && (
                          <span className="text-violet-300 text-[10px] bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded-full truncate max-w-[160px]" title={ev.context}>
                            → {ev.context}
                          </span>
                        )}
                        <span className="text-slate-600 text-[10px] ml-auto">
                          {new Date(ev.timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-300 whitespace-pre-wrap break-words leading-relaxed bg-[#0d1017] rounded-lg px-2 py-1.5">{ev.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {/* ── 加拿大监控 ── */}
        {tab === "hashmon" && (
          <div className="space-y-3">
            {/* 监控群组列表 */}
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setGroupsCollapsed(c => !c)}
                  className="flex items-center gap-2 flex-1 text-left"
                >
                  <span className="text-white font-semibold text-sm">监控群组</span>
                  <span className="text-slate-500 text-xs">({canadaGroups.length})</span>
                  <span className="text-slate-500 text-xs ml-auto">{groupsCollapsed ? "▶" : "▼"}</span>
                </button>
                <button
                  onClick={() => void openCanadaPicker()}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors ml-3"
                >+ 添加</button>
              </div>
              {!groupsCollapsed && (
                <div className="mt-3">
                  {canadaGroups.length === 0 ? (
                    <button
                      onClick={() => void openCanadaPicker()}
                      className="w-full py-2.5 rounded-xl border border-dashed border-[#353a55] text-slate-400 text-sm hover:border-blue-500/50 hover:text-blue-400 transition-colors"
                    >
                      + 选择要监控的加拿大群组
                    </button>
                  ) : (
                    <div className="space-y-1.5">
                      {canadaGroups.map(g => (
                        <div key={g.groupId} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[#0d1117] border border-[#252a3d]">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${g.active ? "bg-emerald-400" : "bg-slate-500"}`} />
                          <span className="text-white text-sm truncate flex-1">{g.groupTitle ?? g.groupId}</span>
                          <button
                            onClick={() => void removeCanadaGroup(g.groupId)}
                            className="text-[10px] text-red-400/70 hover:text-red-400 transition-colors flex-shrink-0"
                          >移除</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 群组选择弹层 */}
            {canadaPickerOpen && (
              <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={() => setCanadaPickerOpen(false)}>
                <div className="bg-[#161929] border border-[#252a3d] rounded-t-2xl w-full max-w-lg p-4 pb-8" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-white font-semibold text-sm">添加加拿大监控群组</span>
                    <button onClick={() => setCanadaPickerOpen(false)} className="text-slate-400 text-lg leading-none">×</button>
                  </div>
                  <input
                    className="w-full bg-[#0d1117] border border-[#252a3d] rounded-xl px-3 py-2 text-sm text-white placeholder-slate-600 mb-3 outline-none"
                    placeholder="搜索群名…"
                    value={canadaPickerSearch}
                    onChange={e => setCanadaPickerSearch(e.target.value)}
                  />
                  <div className="overflow-y-auto max-h-64 space-y-1">
                    {canadaPickerList.length === 0 && (
                      <div className="text-center text-slate-600 text-sm py-6">
                        暂无群组，请先连接 TG 账号并同步群列表
                      </div>
                    )}
                    {canadaPickerList
                      .filter(g => !canadaPickerSearch || g.title.toLowerCase().includes(canadaPickerSearch.toLowerCase()))
                      .map(g => {
                        const alreadyAdded = canadaGroups.some(m => m.groupId === g.id || m.groupId === `-100${g.id}`);
                        return (
                          <button
                            key={g.id}
                            disabled={canadaPickerSaving === g.id || alreadyAdded}
                            onClick={() => void addCanadaGroup(g.id)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-white/5 transition-colors ${alreadyAdded ? "opacity-40 cursor-not-allowed border border-transparent" : "border border-transparent"}`}
                          >
                            <span className="text-slate-500 text-xs">{g.type === "channel" ? "📢" : "👥"}</span>
                            <span className="text-white text-sm truncate flex-1">{g.title}</span>
                            {alreadyAdded && <span className="text-emerald-400 text-xs flex-shrink-0">已添加</span>}
                            {canadaPickerSaving === g.id && <span className="text-blue-400 text-xs flex-shrink-0">添加中…</span>}
                          </button>
                        );
                      })
                    }
                  </div>
                </div>
              </div>
            )}

            {/* 期号 + 合计 */}
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-white font-semibold text-sm">🍁 加拿大下注实时监控</span>
                  {/* 实时连接指示灯 */}
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  {/* 数字期号 */}
                  <span className="text-xs text-white font-mono font-bold">
                    {hashTerm ? `${hashTerm} 期` : hashPeriod ? `${hashPeriod.slice(0, 8)}…` : "等待数据…"}
                  </span>
                  {/* 最近更新时间 */}
                  <span className={`text-[10px] font-mono ${hashLastBetAt > 0 && nowTs - hashLastBetAt < 10_000 ? "text-emerald-400" : "text-slate-600"}`}>
                    {hashLastBetAt > 0
                      ? (() => {
                          const s = Math.floor((nowTs - hashLastBetAt) / 1000);
                          if (s < 60) return `${s}秒前`;
                          return `${Math.floor(s / 60)}分${s % 60}秒前`;
                        })()
                      : "暂无数据"}
                  </span>
                </div>
              </div>
              {(() => {
                const KK_RATE = 100_000; // KK 100,000 = 1 USDT
                const ct = hashBets.reduce((acc, b) => { acc[b.currency] += b.amount; return acc; }, { kk: 0, usdt: 0, cny: 0 });
                const colors: Record<string, string> = { kk: "border-yellow-500/40 bg-yellow-500/8", usdt: "border-emerald-500/40 bg-emerald-500/8", cny: "border-blue-500/40 bg-blue-500/8" };
                const textColors: Record<string, string> = { kk: "text-yellow-400", usdt: "text-emerald-400", cny: "text-blue-400" };
                const kkUsdt = ct.kk / KK_RATE;
                return (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      {(["kk", "usdt", "cny"] as const).map(cur => (
                        <div key={cur} className={`rounded-xl border px-3 py-2.5 text-center ${colors[cur]}`}>
                          <div className={`text-xs font-semibold uppercase tracking-wider mb-1 ${textColors[cur]}`}>{cur === "kk" ? "KK" : cur.toUpperCase()}</div>
                          <div className="text-white font-bold text-base">
                            {ct[cur] > 0 ? ct[cur].toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—"}
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* KK 闪兑折合 USDT */}
                    {ct.kk > 0 && (
                      <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-yellow-500/5 border border-yellow-500/20 text-xs mt-1">
                        <span className="text-yellow-400/70">⚡ KK 闪兑折合</span>
                        <span className="text-white font-mono">
                          {ct.kk.toLocaleString("zh-CN", { maximumFractionDigits: 0 })} KK
                          <span className="text-slate-500 mx-1">÷ 100,000 =</span>
                          <span className="text-emerald-400 font-bold">{kkUsdt.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDT</span>
                        </span>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {/* 方向统计 */}
            {hashBets.length > 0 && (() => {
              type Dir = "大单" | "大双" | "大" | "小单" | "小双" | "小";
              type Cur = "kk" | "usdt" | "cny";
              const zero = () => ({ kk: 0, usdt: 0, cny: 0 });
              const dt: Record<Dir, { kk: number; usdt: number; cny: number }> = {
                "大单": zero(), "大双": zero(), "大": zero(),
                "小单": zero(), "小双": zero(), "小": zero(),
              };
              for (const b of hashBets) {
                const d = b.direction as Dir;
                if (d in dt) dt[d][b.currency] += b.amount;
              }
              const sumDir = (d: Dir) => dt[d].kk + dt[d].usdt + dt[d].cny;
              const bigTotal = sumDir("大单") + sumDir("大双") + sumDir("大");
              const smallTotal = sumDir("小单") + sumDir("小双") + sumDir("小");
              const grandTotal = bigTotal + smallTotal;
              const pct = (n: number) => grandTotal > 0 ? Math.round(n / grandTotal * 100) : 0;
              const fmt = (n: number) => n > 0 ? n.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) : "";
              const curLabel: Record<Cur, { label: string; cls: string }> = {
                kk:   { label: "KK",   cls: "text-yellow-400" },
                usdt: { label: "USDT", cls: "text-emerald-400" },
                cny:  { label: "CNY",  cls: "text-blue-400" },
              };
              const KK_RATE = 100_000;
              const CNY_RATE = 6.7;
              const toUsdt = (c: { kk: number; usdt: number; cny: number }) =>
                c.kk / KK_RATE + c.usdt + c.cny / CNY_RATE;
              const fmtU = (u: number) => u.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              const CurLines = ({ totCur }: { totCur: { kk: number; usdt: number; cny: number } }) => {
                const uTotal = toUsdt(totCur);
                return (
                  <div className="space-y-1 mt-1.5">
                    {(["kk", "usdt", "cny"] as Cur[]).map(c => totCur[c] > 0 ? (
                      <div key={c} className="flex items-center justify-between gap-2 text-sm">
                        <span className={`${curLabel[c].cls} font-semibold`}>{curLabel[c].label}</span>
                        <span className="text-white font-mono">{fmt(totCur[c])}</span>
                      </div>
                    ) : null)}
                    {uTotal > 0 && (
                      <div className="flex items-center justify-between gap-2 text-sm border-t border-emerald-500/20 pt-1 mt-1">
                        <span className="text-emerald-400/70 font-semibold">≈ U</span>
                        <span className="text-emerald-300 font-mono font-bold">{fmtU(uTotal)}</span>
                      </div>
                    )}
                  </div>
                );
              };
              const bigCur = { kk: ["大单","大双","大" as Dir].reduce((s,d) => s + dt[d as Dir].kk, 0), usdt: ["大单","大双","大" as Dir].reduce((s,d) => s + dt[d as Dir].usdt, 0), cny: ["大单","大双","大" as Dir].reduce((s,d) => s + dt[d as Dir].cny, 0) };
              const smlCur = { kk: ["小单","小双","小" as Dir].reduce((s,d) => s + dt[d as Dir].kk, 0), usdt: ["小单","小双","小" as Dir].reduce((s,d) => s + dt[d as Dir].usdt, 0), cny: ["小单","小双","小" as Dir].reduce((s,d) => s + dt[d as Dir].cny, 0) };
              return (
                <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4 space-y-3">
                  <span className="text-white font-semibold text-sm">方向统计</span>
                  {/* 大 vs 小 总览（含币种细分） */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2.5">
                      <div className="text-xs text-red-400 font-semibold text-center">🔴 大（合计）</div>
                      <div className="text-red-300 font-bold text-2xl text-center">{pct(bigTotal)}%</div>
                      <CurLines totCur={bigCur} />
                    </div>
                    <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 px-3 py-2.5">
                      <div className="text-xs text-sky-400 font-semibold text-center">🔵 小（合计）</div>
                      <div className="text-sky-300 font-bold text-2xl text-center">{pct(smallTotal)}%</div>
                      <CurLines totCur={smlCur} />
                    </div>
                  </div>
                  {/* 进度条 */}
                  {grandTotal > 0 && (
                    <div className="h-1.5 rounded-full bg-sky-500/30 overflow-hidden">
                      <div className="h-full rounded-full bg-red-500/70 transition-all duration-300" style={{ width: `${pct(bigTotal)}%` }} />
                    </div>
                  )}
                  {/* 细分：每格按币种列出 */}
                  <div className="grid grid-cols-3 gap-1.5">
                    {(["大单", "大双", "大", "小单", "小双", "小"] as Dir[]).map(d => {
                      const isBig = d.startsWith("大");
                      return (
                        <div key={d} className={`rounded-lg border px-2.5 py-2 ${isBig ? "border-red-500/20 bg-red-500/5" : "border-sky-500/20 bg-sky-500/5"}`}>
                          <div className={`text-sm font-semibold text-center mb-1.5 ${isBig ? "text-red-400" : "text-sky-400"}`}>{d}</div>
                          {(["kk", "usdt", "cny"] as Cur[]).map(c => dt[d][c] > 0 ? (
                            <div key={c} className="flex items-center justify-between text-xs">
                              <span className={`${curLabel[c].cls} font-semibold`}>{curLabel[c].label}</span>
                              <span className="text-white font-mono">{fmt(dt[d][c])}</span>
                            </div>
                          ) : null)}
                          {toUsdt(dt[d]) > 0 && (
                            <div className="flex items-center justify-between text-xs border-t border-emerald-500/20 pt-1 mt-1">
                              <span className="text-emerald-400/70 font-semibold">≈ U</span>
                              <span className="text-emerald-300 font-mono font-bold">{fmtU(toUsdt(dt[d]))}</span>
                            </div>
                          )}
                          {sumDir(d) === 0 && <div className="text-slate-700 text-[10px] text-center">—</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* 开奖历史 */}
            {(() => {
              const KK_RATE = 100_000;
              const CNY_RATE = 6.7;
              const toU = (d: { kk: number; usdt: number; cny: number }) =>
                d.kk / KK_RATE + d.usdt + d.cny / CNY_RATE;
              const fU = (u: number) => u > 0
                ? u.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : "—";
              const resultColor = (r: string | null) => {
                if (!r) return "text-slate-500";
                if (r.startsWith("大")) return "text-red-400";
                return "text-sky-400";
              };
              const dirCols = ["大单", "大双", "大", "小单", "小双", "小"] as const;
              const liveZero = () => ({ kk: 0, usdt: 0, cny: 0 });
              const liveDirs: Record<KillDir, { kk: number; usdt: number; cny: number }> = {
                大单: liveZero(),
                大双: liveZero(),
                小单: liveZero(),
                小双: liveZero(),
              };
              for (const b of hashBets) {
                const d = b.direction as KillDir;
                if (d in liveDirs) liveDirs[d][b.currency] += b.amount;
              }
              const hasLive = Object.values(liveDirs).some(v => v.kk + v.usdt + v.cny > 0);
              const pickLiveKill3 = () => {
                if (!hasLive) return;
                const ranked = KILL_DIRS
                  .map(d => ({ d, u: toU(liveDirs[d]) }))
                  .sort((a, b) => a.u - b.u);
                const pick = ranked.slice(0, 3).map(x => x.d);
                const text = pick.map(d => `${d} ${killAmts[d]}`.trim()).join("\n");
                void navigator.clipboard.writeText(text);
                setHashCopied(true);
                setTimeout(() => setHashCopied(false), 2000);
              };
              return (
                <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#252a3d] flex items-center gap-2">
                    <span className="text-white font-semibold text-sm">📋 开奖记录</span>
                    <span className="text-slate-500 text-xs">最近 {hashHistory.length} 期</span>
                    <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                      <div className="flex items-center gap-1 flex-wrap">
                        {KILL_DIRS.map(d => (
                          <div key={d} className="flex items-center gap-1 bg-[#0d1117] border border-[#252a3d] rounded-lg px-2 py-1">
                            <span className="text-[10px] text-slate-500">{d}</span>
                            <input
                              type="number"
                              value={killAmts[d]}
                              onChange={e => setKillAmts(p => ({ ...p, [d]: e.target.value }))}
                              className="w-12 bg-transparent text-white text-xs font-mono outline-none"
                              min="0"
                            />
                          </div>
                        ))}
                      </div>
                      <button
                        disabled={!hasLive}
                        onClick={pickLiveKill3}
                        className="text-xs px-2 py-1 rounded-lg border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40 transition"
                      >
                        {hashCopied ? "已复制" : "复制最小三组"}
                      </button>
                      <button
                        onClick={clearCanadaMonitorLocal}
                        className="text-xs px-2 py-1 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 transition"
                      >
                        清空
                      </button>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-[#252a3d] text-slate-500">
                          <th className="px-3 py-2 text-left font-medium whitespace-nowrap">期号</th>
                          <th className="px-3 py-2 text-center font-medium whitespace-nowrap">结果</th>
                          {dirCols.map(d => (
                            <th key={d} className={`px-3 py-2 text-right font-medium whitespace-nowrap ${d.startsWith("大") ? "text-red-500/60" : "text-sky-500/60"}`}>{d} ≈U</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {hashHistory.length === 0 && (
                          <tr>
                            <td colSpan={8} className="px-4 py-6 text-center text-slate-600 text-xs">
                              等待下一期"停止下注"消息后自动记录…
                            </td>
                          </tr>
                        )}
                        {hashHistory.map((rec, i) => {
                          const totalU = dirCols.reduce((s, d) => s + toU(rec.dirs[d] ?? { kk: 0, usdt: 0, cny: 0 }), 0);
                          void totalU;
                          return (
                            <tr key={i} className="border-b border-[#1a1f31] hover:bg-[#1a1f31]/50 transition-colors">
                              <td className="px-3 py-2 text-slate-400 font-mono whitespace-nowrap">
                                {rec.term ?? "—"}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {rec.result
                                  ? <span className={`font-bold text-sm ${resultColor(rec.result)}`}>{rec.result}</span>
                                  : <span className="text-slate-600 animate-pulse">开奖中…</span>
                                }
                              </td>
                              {dirCols.map(d => {
                                const u = toU(rec.dirs[d] ?? { kk: 0, usdt: 0, cny: 0 });
                                // "大"覆盖大单/大双，"小"覆盖小单/小双
                                const isResult = rec.result === d
                                  || (d === "大" && rec.result != null && rec.result.startsWith("大"))
                                  || (d === "小" && rec.result != null && rec.result.startsWith("小"));
                                const isLosing = !!rec.result && !isResult;
                                return (
                                  <td key={d} className={`px-3 py-2 text-right font-mono whitespace-nowrap ${isResult ? "text-emerald-300 font-bold" : isLosing ? "text-red-400" : "text-slate-400"}`}>
                                    {isResult && u > 0 && <span className="mr-1 text-emerald-500">🏆</span>}
                                    {fU(u)}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            {/* 下注列表 */}
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-[#252a3d] flex items-center justify-between">
                <span className="text-white font-semibold text-sm">下注明细</span>
                <span className="text-xs text-slate-500">{hashBets.length} 条</span>
              </div>
              {hashBets.length === 0 ? (
                <div className="px-4 py-8 text-center text-slate-600 text-sm">
                  暂无下注记录，等待群组消息…
                </div>
              ) : (
                <div className="divide-y divide-[#1e2235]">
                  {hashBets.map(b => {
                    const curColor: Record<string, string> = {
                      kk: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
                      usdt: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
                      cny: "text-blue-400 bg-blue-500/10 border-blue-500/30",
                    };
                    const dirColor = b.direction.startsWith("大") ? "text-red-400" : "text-sky-400";
                    return (
                      <div key={b.id} className="px-4 py-2.5 flex items-center gap-3 hover:bg-white/[0.02]">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${curColor[b.currency]} flex-shrink-0`}>
                          {b.currency.toUpperCase()}
                        </span>
                        <span className={`text-sm font-semibold w-16 text-right flex-shrink-0 ${dirColor}`}>
                          {b.direction}
                        </span>
                        <span className="text-white font-mono text-sm flex-shrink-0 w-20 text-right">
                          {b.amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
                        </span>
                        <span className="text-slate-400 text-xs truncate flex-1 min-w-0">{b.senderName || b.senderId}</span>
                        <span className="text-slate-600 text-[10px] flex-shrink-0 tabular-nums">
                          {new Date(b.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "privmon" && (
          <div className="space-y-3">
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setGroupsCollapsed(c => !c)}
                  className="flex items-center gap-2 flex-1 text-left"
                >
                  <span className="text-white font-semibold text-sm">监控群组</span>
                  <span className="text-slate-500 text-xs">({privateGroups.length})</span>
                  <span className="text-slate-500 text-xs ml-auto">{groupsCollapsed ? "▶" : "▼"}</span>
                </button>
                <button
                  onClick={() => void openPrivatePicker()}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors ml-3"
                >+ 添加</button>
              </div>
              {!groupsCollapsed && (
                <div className="mt-3">
                  {privateGroups.length === 0 ? (
                    <button
                      onClick={() => void openPrivatePicker()}
                      className="w-full py-2.5 rounded-xl border border-dashed border-[#353a55] text-slate-400 text-sm hover:border-blue-500/50 hover:text-blue-400 transition-colors"
                    >
                      + 选择要监控的群组
                    </button>
                  ) : (
                    <div className="space-y-1.5">
                      {privateGroups.map(g => (
                        <div key={g.groupId} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[#0d1117] border border-[#252a3d]">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${g.active ? "bg-emerald-400" : "bg-slate-500"}`} />
                          <span className="text-white text-sm truncate flex-1">{g.groupTitle ?? g.groupId}</span>
                          <button
                            onClick={() => void removePrivateGroup(g.groupId)}
                            className="text-[10px] text-red-400/70 hover:text-red-400 transition-colors flex-shrink-0"
                          >移除</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {privatePickerOpen && (
              <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={() => setPrivatePickerOpen(false)}>
                <div className="bg-[#161929] border border-[#252a3d] rounded-t-2xl w-full max-w-lg p-4 pb-8" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-white font-semibold text-sm">添加监控群组</span>
                    <button onClick={() => setPrivatePickerOpen(false)} className="text-slate-400 text-lg leading-none">×</button>
                  </div>
                  <input
                    className="w-full bg-[#0d1117] border border-[#252a3d] rounded-xl px-3 py-2 text-sm text-white placeholder-slate-600 mb-3 outline-none"
                    placeholder="搜索群名…"
                    value={privatePickerSearch}
                    onChange={e => setPrivatePickerSearch(e.target.value)}
                  />
                  <div className="overflow-y-auto max-h-64 space-y-1">
                    {privatePickerList.length === 0 && (
                      <div className="text-center text-slate-600 text-sm py-6">
                        暂无群组，请先连接 TG 账号并同步群列表
                      </div>
                    )}
                    {privatePickerList
                      .filter(g => !privatePickerSearch || g.title.toLowerCase().includes(privatePickerSearch.toLowerCase()))
                      .map(g => {
                        const alreadyAdded = privateGroups.some(m => m.groupId === g.id || m.groupId === `-100${g.id}`);
                        return (
                          <button
                            key={g.id}
                            disabled={privatePickerSaving === g.id || alreadyAdded}
                            onClick={() => void addPrivateGroup(g.id)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-white/5 transition-colors ${alreadyAdded ? "opacity-40 cursor-not-allowed border border-transparent" : "border border-transparent"}`}
                          >
                            <span className="text-slate-500 text-xs">{g.type === "channel" ? "📢" : "👥"}</span>
                            <span className="text-white text-sm truncate flex-1">{g.title}</span>
                            {alreadyAdded && <span className="text-emerald-400 text-xs flex-shrink-0">已添加</span>}
                            {privatePickerSaving === g.id && <span className="text-blue-400 text-xs flex-shrink-0">添加中…</span>}
                          </button>
                        );
                      })
                    }
                  </div>
                </div>
              </div>
            )}

            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-white font-semibold text-sm">🧩 新群下注监控</span>
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-xs text-white font-mono font-bold">
                    {privateTerm ? `${privateTerm} 期` : "等待期号…"}
                  </span>
                  <span className={`text-[10px] font-mono ${privateLastBetAt > 0 && nowTs - privateLastBetAt < 10_000 ? "text-emerald-400" : "text-slate-600"}`}>
                    {privateLastBetAt > 0
                      ? (() => {
                          const s = Math.floor((nowTs - privateLastBetAt) / 1000);
                          if (s < 60) return `${s}秒前`;
                          return `${Math.floor(s / 60)}分${s % 60}秒前`;
                        })()
                      : "暂无数据"}
                  </span>
                </div>
              </div>
              <div className="text-xs text-slate-500">
                只显示本期（新期开盘消息出现后会自动清空上期）
              </div>
            </div>

            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-[#252a3d] flex items-center justify-between">
                <span className="text-white font-semibold text-sm">金额汇总</span>
                <span className="text-xs text-slate-500">大 / 小 / 单 / 双 / 组合</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3">
                {privateSummary.map(item => {
                  const dirColor =
                    item.dir.startsWith("大") ? "text-red-400" :
                    item.dir.startsWith("小") ? "text-sky-400" :
                    item.dir === "单" ? "text-orange-300" :
                    item.dir === "双" ? "text-violet-300" :
                    "text-slate-300";
                  return (
                    <div key={item.dir} className="rounded-xl border border-[#252a3d] bg-[#0d1117] px-3 py-2.5">
                      <div className={`text-sm font-semibold ${dirColor}`}>{item.dir}</div>
                      <div className="mt-1 text-white font-mono text-base">
                        {item.amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-[#252a3d] flex items-center justify-between">
                <span className="text-white font-semibold text-sm">下注明细</span>
                <span className="text-xs text-slate-500">{privateBets.length} 条</span>
              </div>
              {privateBets.length === 0 ? (
                <div className="px-4 py-8 text-center text-slate-600 text-sm">
                  暂无下注记录，等待群组消息…
                </div>
              ) : (
                <div className="divide-y divide-[#1e2235]">
                  {privateBets.map(b => {
                    const dirColor = b.direction.startsWith("大") ? "text-red-400" : b.direction.startsWith("小") ? "text-sky-400" : "text-slate-300";
                    return (
                      <div key={b.id} className="px-4 py-2.5 flex items-center gap-3 hover:bg-white/[0.02]">
                        <span className={`text-sm font-semibold w-16 text-right flex-shrink-0 ${dirColor}`}>
                          {b.direction}
                        </span>
                        <span className="text-white font-mono text-sm flex-shrink-0 w-20 text-right">
                          {b.amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
                        </span>
                        <span className="text-slate-400 text-xs truncate flex-1 min-w-0">{b.senderName || b.senderId}</span>
                        <span className="text-slate-600 text-[10px] flex-shrink-0 tabular-nums">
                          {new Date(b.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

      </div>
      <BottomNav />
    </div>
  );
}
