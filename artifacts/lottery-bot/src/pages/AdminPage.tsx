import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";
import { api, type AdminCard } from "../lib/api";

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  daily: { label: "天卡", color: "text-green-400 bg-green-500/10 border-green-500/30" },
  weekly: { label: "周卡", color: "text-blue-400 bg-blue-500/10 border-blue-500/30" },
  monthly: { label: "月卡", color: "text-purple-400 bg-purple-500/10 border-purple-500/30" },
};

export default function AdminPage() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [cards, setCards] = useState<AdminCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState<"daily" | "weekly" | "monthly">("weekly");
  const [count, setCount] = useState("1");
  const [note, setNote] = useState("");
  const [generating, setGenerating] = useState(false);
  const [newKeys, setNewKeys] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unused" | "active" | "expired">("all");

  useEffect(() => {
    if (!user?.isAdmin) { setLocation("/"); return; }
    void loadCards();
  }, [user, setLocation]);

  const loadCards = async () => {
    setLoading(true);
    try {
      const { cards: c } = await api.admin.listCards();
      setCards(c);
    } finally { setLoading(false); }
  };

  const generate = async () => {
    setGenerating(true);
    setNewKeys([]);
    try {
      const { keys } = await api.admin.generateCards(type, Number(count) || 1, note || undefined);
      setNewKeys(keys);
      await loadCards();
    } finally { setGenerating(false); }
  };

  const deleteCard = async (id: number) => {
    if (!confirm("确认删除此卡密？")) return;
    await api.admin.deleteCard(id);
    await loadCards();
  };

  const copyKey = (key: string) => {
    void navigator.clipboard.writeText(key);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const copyAll = (keys: string[]) => {
    void navigator.clipboard.writeText(keys.join("\n"));
    setCopied("all");
    setTimeout(() => setCopied(null), 2000);
  };

  const filtered = cards.filter(c => {
    if (filter === "unused") return !c.isUsed;
    if (filter === "active") return c.isActive;
    if (filter === "expired") return c.isUsed && !c.isActive;
    return true;
  });

  const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";

  return (
    <div className="min-h-screen bg-[#0b0e1a] text-white">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-[#0b0e1a]/95 border-b border-[#1e2235] backdrop-blur">
        <div className="max-w-2xl mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <button onClick={() => setLocation("/")} className="text-slate-400 hover:text-white transition text-lg">←</button>
            <h1 className="font-bold text-white">后台管理</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500 text-xs">{user?.username}</span>
            <button onClick={() => void logout()} className="text-slate-500 hover:text-slate-300 text-xs transition">退出</button>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-4 space-y-4">

        {/* Generate */}
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
                <button onClick={() => copyAll(newKeys)}
                  className="text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded transition">
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

        {/* Card List */}
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

          {loading ? (
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
                    <button onClick={() => copyKey(c.key)}
                      className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded border border-blue-500/20 hover:border-blue-500/40 transition">
                      {copied === c.key ? "✓" : "复制"}
                    </button>
                    <button onClick={() => void deleteCard(c.id)}
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-500/20 hover:border-red-500/40 transition">
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Stats */}
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
      </div>
    </div>
  );
}
