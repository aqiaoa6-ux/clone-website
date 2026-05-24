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

  // ── monitor tab ──
  const [sessions, setSessions] = useState<AdminTgSession[]>([]);
  const [loadingMon, setLoadingMon] = useState(false);
  const [expandedUser, setExpandedUser] = useState<number | null>(null);
  const [expandedView, setExpandedView] = useState<"bets" | "messages">("messages");
  const [userBets, setUserBets] = useState<Record<number, BetRecord[]>>({});
  const [userMsgs, setUserMsgs] = useState<Record<number, TgChatMessage[]>>({});
  const [loadingDetail, setLoadingDetail] = useState<number | null>(null);

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
    if (view === "messages" && !userMsgs[userId]) {
      setLoadingDetail(userId);
      try { const { messages } = await api.admin.tgMessages(userId); setUserMsgs(p => ({ ...p, [userId]: messages })); }
      finally { setLoadingDetail(null); }
    }
  };

  const refreshMessages = async (userId: number) => {
    setLoadingDetail(userId);
    try { const { messages } = await api.admin.tgMessages(userId); setUserMsgs(p => ({ ...p, [userId]: messages })); }
    finally { setLoadingDetail(null); }
  };

  const setAdmin = async (userId: number, isAdmin: boolean) => {
    setPromotingId(userId);
    try {
      await api.admin.setAdmin(userId, isAdmin);
      await loadUsers();
    } finally { setPromotingId(null); }
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
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-5">
              <h2 className="text-white font-semibold mb-4">生成卡密</h2>
              <div className="grid grid-cols-3 gap-2 mb-4">
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
                    {expandedUser === s.userId && expandedView === "messages" && (
                      <div className="border-t border-[#252a3d]">
                        <div className="flex justify-between items-center px-4 py-2 bg-[#0f1220]">
                          <span className="text-xs text-slate-400">全部 TG 消息（最近200条，含所有群/私聊/频道）</span>
                          <button onClick={() => void refreshMessages(s.userId)} disabled={loadingDetail === s.userId}
                            className="text-[11px] text-blue-400 hover:text-blue-300 transition disabled:opacity-50">
                            {loadingDetail === s.userId ? "刷新中..." : "刷新"}
                          </button>
                        </div>
                        {loadingDetail === s.userId ? (
                          <div className="text-center text-slate-500 py-6 text-sm">加载中...</div>
                        ) : !userMsgs[s.userId] || userMsgs[s.userId]!.length === 0 ? (
                          <div className="text-center text-slate-600 py-6 text-sm">暂无消息（需要先连接 TG）</div>
                        ) : (
                          <div className="max-h-80 overflow-y-auto divide-y divide-[#1e2235]">
                            {userMsgs[s.userId]!.map((m, i) => (
                              <div key={i} className="px-4 py-2.5 text-xs">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <span className="text-slate-500 font-mono text-[10px]">{fmtTime(m.timestamp)}</span>
                                  {m.chatType === "channel" && <span className="text-[9px] text-purple-400 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded">频道</span>}
                                  {m.chatType === "group" && <span className="text-[9px] text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded">群组</span>}
                                  {m.chatType === "private" && <span className="text-[9px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">私聊</span>}
                                  <span className="text-slate-300 font-medium">{m.chatTitle || m.chatId}</span>
                                  {m.senderName && m.senderName !== m.chatTitle && (
                                    <span className="text-slate-500">/ {m.senderName}</span>
                                  )}
                                </div>
                                <div className="text-slate-200 whitespace-pre-wrap break-words leading-relaxed">{m.text}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

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
