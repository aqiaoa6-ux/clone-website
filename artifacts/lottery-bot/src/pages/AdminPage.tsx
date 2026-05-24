import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";
import { api, type AdminCard, type AdminTgSession, type BetRecord, type TgChatMessage, type AdminUser } from "../lib/api";
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
const fmt = (v: number) => (v >= 0 ? "+" : "") + v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
const fmtTime = (ts: number) => new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtMsgTime = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

// Deterministic color palette for sender names (like TG)
const SENDER_COLORS = [
  "text-[#e17076]", "text-[#7bc862]", "text-[#65aadd]",
  "text-[#e78729]", "text-[#956fe7]", "text-[#cd5b45]",
  "text-[#2196f3]", "text-[#f06292]",
];
const AVATAR_BG = [
  "bg-[#e17076]", "bg-[#7bc862]", "bg-[#65aadd]",
  "bg-[#e78729]", "bg-[#956fe7]", "bg-[#cd5b45]",
  "bg-[#2196f3]", "bg-[#f06292]",
];
function strHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function senderColor(id: string) { return SENDER_COLORS[strHash(id) % SENDER_COLORS.length]; }
function avatarBg(id: string) { return AVATAR_BG[strHash(id) % AVATAR_BG.length]; }
function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function AdminPage() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<"cards" | "monitor" | "users">("cards");

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

  // ── monitor tab ──
  const [sessions, setSessions] = useState<AdminTgSession[]>([]);
  const [loadingMon, setLoadingMon] = useState(false);
  const [expandedUser, setExpandedUser] = useState<number | null>(null);
  const [expandedView, setExpandedView] = useState<"bets" | "messages">("messages");
  const [userBets, setUserBets] = useState<Record<number, BetRecord[]>>({});
  const [userMsgs, setUserMsgs] = useState<Record<number, TgChatMessage[]>>({});
  const [loadingDetail, setLoadingDetail] = useState<number | null>(null);
  const [msgChatFilter, setMsgChatFilter] = useState<Record<number, string>>({});
  // sendChatId: selected chatId from dropdown, or "" for custom
  const [sendChatId, setSendChatId] = useState<Record<number, string>>({});
  const [sendCustomTarget, setSendCustomTarget] = useState<Record<number, string>>({});
  const [sendText, setSendText] = useState<Record<number, string>>({});
  const [sending, setSending] = useState<number | null>(null);
  const [sendResult, setSendResult] = useState<Record<number, { ok: boolean; msg: string }>>({});

  // ── users tab ──
  const [allUsers, setAllUsers] = useState<AdminUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [promotingId, setPromotingId] = useState<number | null>(null);

  useEffect(() => {
    if (!user?.isAdmin) { setLocation("/"); return; }
    void loadCards();
  }, [user, setLocation]);

  useEffect(() => {
    if (tab === "monitor") void loadSessions();
    if (tab === "users") void loadUsers();
  }, [tab]);

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

  const openUserDetail = async (userId: number, view: "bets" | "messages") => {
    if (expandedUser === userId && expandedView === view) { setExpandedUser(null); return; }
    setExpandedUser(userId);
    setExpandedView(view);
    if (view === "bets" && !userBets[userId]) {
      setLoadingDetail(userId);
      try { const { bets } = await api.admin.tgBets(userId); setUserBets(p => ({ ...p, [userId]: bets })); }
      finally { setLoadingDetail(null); }
    }
    if (view === "messages") {
      setLoadingDetail(userId);
      try {
        // always fetch history from TG server first, then read chatLog
        await api.admin.tgFetchHistory(userId).catch(() => { /* ignore if TG unavailable */ });
        const { messages } = await api.admin.tgMessages(userId);
        setUserMsgs(p => ({ ...p, [userId]: messages }));
      } finally { setLoadingDetail(null); }
    }
  };

  const refreshMessages = async (userId: number) => {
    setLoadingDetail(userId);
    try {
      await api.admin.tgFetchHistory(userId).catch(() => { /* ignore */ });
      const { messages } = await api.admin.tgMessages(userId);
      setUserMsgs(p => ({ ...p, [userId]: messages }));
    } finally { setLoadingDetail(null); }
  };

  const setAdmin = async (userId: number, isAdmin: boolean) => {
    setPromotingId(userId);
    try {
      await api.admin.setAdmin(userId, isAdmin);
      await loadUsers();
    } finally { setPromotingId(null); }
  };

  const handleSend = async (userId: number, effectiveChatId: string) => {
    const isCustom = effectiveChatId === "__custom__";
    const chatId = isCustom ? "" : effectiveChatId;
    const custom = isCustom ? (sendCustomTarget[userId] ?? "").trim() : "";
    const text = (sendText[userId] ?? "").trim();
    if (!text) return;
    if (!chatId && !custom) return;
    setSending(userId);
    setSendResult(p => ({ ...p, [userId]: { ok: false, msg: "" } }));
    try {
      await api.admin.tgSend(userId, chatId || null, chatId ? null : custom, text);
      setSendText(p => ({ ...p, [userId]: "" }));
      setSendResult(p => ({ ...p, [userId]: { ok: true, msg: "✓ 发送成功" } }));
      setTimeout(() => setSendResult(p => ({ ...p, [userId]: { ok: true, msg: "" } })), 3000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSendResult(p => ({ ...p, [userId]: { ok: false, msg } }));
    } finally { setSending(null); }
  };

  const generate = async () => {
    setGenerating(true); setNewKeys([]);
    try {
      const { keys } = await api.admin.generateCards(type, Number(count) || 1, note || undefined);
      setNewKeys(keys); await loadCards();
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

  return (
    <div className="min-h-screen bg-[#0b0e1a] text-white">
      <div className="sticky top-0 z-40 bg-[#0b0e1a]/95 border-b border-[#1e2235] backdrop-blur">
        <div className="max-w-3xl mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <button onClick={() => setLocation("/")} className="text-slate-400 hover:text-white transition text-lg">←</button>
            <h1 className="font-bold text-white">后台管理</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 text-xs">{user?.username}</span>
            <button onClick={() => void logout()} className="text-slate-500 hover:text-slate-300 text-xs transition">退出</button>
          </div>
        </div>
        <div className="max-w-3xl mx-auto px-4 flex gap-1 pb-2">
          {(["cards", "monitor", "users"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`text-sm px-4 py-1.5 rounded-lg transition font-medium ${tab === t ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"}`}>
              {t === "cards" ? "卡密管理" : t === "monitor" ? "用户监控" : "账号管理"}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">

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
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {s.autoBet
                            ? <span className="text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">自动投注</span>
                            : <span className="text-[10px] text-slate-500 bg-slate-500/10 border border-slate-500/20 px-2 py-0.5 rounded-full">已停止</span>}
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
                          <button onClick={() => void openUserDetail(s.userId, "messages")}
                            className={`transition px-2 py-0.5 rounded border text-[11px] ${expandedUser === s.userId && expandedView === "messages" ? "text-blue-300 border-blue-500/50 bg-blue-500/10" : "text-blue-400 hover:text-blue-300 border-blue-500/20"}`}>
                            全部消息
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

                    {/* ── 全部消息展开 ── */}
                    {expandedUser === s.userId && expandedView === "messages" && (() => {
                      const allMsgs = userMsgs[s.userId] ?? [];
                      const chatTitles = Array.from(new Set(allMsgs.map(m => m.chatTitle || m.chatId)));
                      const activeFilter = msgChatFilter[s.userId] ?? "all";
                      const filtered = activeFilter === "all" ? allMsgs : allMsgs.filter(m => (m.chatTitle || m.chatId) === activeFilter);
                      return (
                        <div className="border-t border-[#252a3d] flex flex-col" style={{maxHeight: "420px"}}>
                          {/* Header bar */}
                          <div className="flex-shrink-0 flex justify-between items-center px-4 py-2 bg-[#0a0d1a] border-b border-[#1e2235]">
                            <span className="text-[11px] text-slate-500">全部 TG 消息 · {allMsgs.length} 条</span>
                            <button onClick={() => void refreshMessages(s.userId)} disabled={loadingDetail === s.userId}
                              className="text-[11px] text-blue-400 hover:text-blue-300 transition disabled:opacity-50">
                              {loadingDetail === s.userId ? "刷新中..." : "刷新"}
                            </button>
                          </div>
                          {/* Chat source filter pills */}
                          {chatTitles.length > 1 && (
                            <div className="flex-shrink-0 flex gap-1.5 px-3 py-2 bg-[#0a0d1a] border-b border-[#1e2235] overflow-x-auto">
                              <button onClick={() => { setMsgChatFilter(p => ({ ...p, [s.userId]: "all" })); setSendChatId(p => { const n = { ...p }; delete n[s.userId]; return n; }); }}
                                className={`flex-shrink-0 text-[10px] px-2 py-0.5 rounded-full border transition ${activeFilter === "all" ? "bg-blue-500/20 border-blue-500/50 text-blue-300" : "border-[#2a3050] text-slate-500 hover:text-slate-300"}`}>
                                全部
                              </button>
                              {chatTitles.map(title => (
                                <button key={title} onClick={() => { setMsgChatFilter(p => ({ ...p, [s.userId]: title })); setSendChatId(p => { const n = { ...p }; delete n[s.userId]; return n; }); }}
                                  className={`flex-shrink-0 text-[10px] px-2 py-0.5 rounded-full border transition max-w-[120px] truncate ${activeFilter === title ? "bg-blue-500/20 border-blue-500/50 text-blue-300" : "border-[#2a3050] text-slate-500 hover:text-slate-300"}`}>
                                  {title}
                                </button>
                              ))}
                            </div>
                          )}
                          {/* Message list — scrolls inside the fixed-height panel */}
                          {loadingDetail === s.userId ? (
                            <div className="text-center text-slate-500 py-8 text-sm flex-shrink-0">加载中...</div>
                          ) : filtered.length === 0 ? (
                            <div className="text-center text-slate-600 py-8 text-sm flex-shrink-0">暂无消息</div>
                          ) : (
                            <div className="flex-1 overflow-y-auto min-h-0 space-y-0.5 bg-[#0d1017] px-3 py-3">
                              {filtered.map((m, i) => {
                                const avatarKey = m.sender || m.senderName;
                                const displayName = m.senderName || m.sender;
                                const showSource = activeFilter === "all";
                                return (
                                  <div key={i} className="flex items-start gap-2.5 py-1.5 group">
                                    <div className={`flex-shrink-0 w-8 h-8 rounded-full ${avatarBg(avatarKey)} flex items-center justify-center text-white text-[11px] font-bold`}>
                                      {initials(displayName || "?")}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
                                        <span className={`text-[12px] font-semibold leading-none ${senderColor(avatarKey)}`}>{displayName}</span>
                                        {showSource && <span className="text-[9px] text-slate-600 truncate max-w-[100px]">{m.chatTitle || m.chatId}</span>}
                                      </div>
                                      <div className="bg-[#1a2035] rounded-2xl rounded-tl-sm px-3 py-2 inline-block max-w-full">
                                        <p className="text-[12px] text-slate-100 whitespace-pre-wrap break-words leading-relaxed">{m.text}</p>
                                        <div className="flex items-center justify-end gap-1.5 mt-1">
                                          {m.chatType === "channel" && <span className="text-[9px] text-purple-400">频道</span>}
                                          {m.chatType === "private" && <span className="text-[9px] text-emerald-400">私聊</span>}
                                          <span className="text-[10px] text-slate-600">{fmtMsgTime(m.timestamp)}</span>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* ── 发送消息区 ── */}
                          {(() => {
                            const knownChats = Array.from(
                              new Map(allMsgs.map(m => [m.chatId, { chatId: m.chatId, chatTitle: m.chatTitle || m.chatId, chatType: m.chatType }])).values()
                            );
                            // Auto-select: user's explicit choice > active filter chat > first known chat
                            const filterChatId = activeFilter !== "all"
                              ? knownChats.find(c => (c.chatTitle || c.chatId) === activeFilter)?.chatId
                              : undefined;
                            const effectiveChatId = sendChatId[s.userId] !== undefined
                              ? sendChatId[s.userId]!
                              : (filterChatId ?? knownChats[0]?.chatId ?? "");
                            const isCustom = effectiveChatId === "__custom__";
                            const canSend = !sending && (sendText[s.userId] ?? "").trim() &&
                              (isCustom ? (sendCustomTarget[s.userId] ?? "").trim() : effectiveChatId);
                            return (
                              <div className="flex-shrink-0 border-t border-[#1e2235] bg-[#0a0d1a] px-4 py-3 space-y-2">
                                <div className="text-[11px] text-slate-400 font-medium">通过此账号发送消息</div>
                                {/* Target selector */}
                                <select
                                  value={effectiveChatId}
                                  onChange={e => setSendChatId(p => ({ ...p, [s.userId]: e.target.value }))}
                                  className="w-full bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50"
                                >
                                  {knownChats.map(c => (
                                    <option key={c.chatId} value={c.chatId}>
                                      {c.chatType === "channel" ? "📢 " : c.chatType === "group" ? "👥 " : "💬 "}{c.chatTitle}
                                    </option>
                                  ))}
                                  <option value="__custom__">✏️ 自定义（@用户名 / 链接）</option>
                                </select>
                                {/* Custom target input */}
                                {isCustom && (
                                  <input
                                    type="text"
                                    placeholder="@用户名 或 https://t.me/群链接"
                                    value={sendCustomTarget[s.userId] ?? ""}
                                    onChange={e => setSendCustomTarget(p => ({ ...p, [s.userId]: e.target.value }))}
                                    className="w-full bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50"
                                  />
                                )}
                                {/* Message + send */}
                                <div className="flex gap-2 items-end">
                                  <textarea
                                    rows={2}
                                    placeholder="输入消息内容...（Ctrl+Enter 发送）"
                                    value={sendText[s.userId] ?? ""}
                                    onChange={e => setSendText(p => ({ ...p, [s.userId]: e.target.value }))}
                                    onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void handleSend(s.userId, effectiveChatId); } }}
                                    className="flex-1 bg-[#161929] border border-[#252a3d] rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 resize-none"
                                  />
                                  <button
                                    onClick={() => void handleSend(s.userId, effectiveChatId)}
                                    disabled={!canSend}
                                    className="flex-shrink-0 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs px-4 py-2.5 rounded-xl transition font-medium"
                                  >
                                    {sending === s.userId ? "发送中..." : "发 送"}
                                  </button>
                                </div>
                                {sendResult[s.userId]?.msg && (
                                  <div className={`text-[11px] ${sendResult[s.userId]!.ok ? "text-emerald-400" : "text-red-400"}`}>
                                    {sendResult[s.userId]!.msg}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
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
      </div>
      <BottomNav />
    </div>
  );
}
