import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import BottomNav from "../components/BottomNav";

const CARD_TYPES = [
  { key: "daily", label: "天卡", desc: "有效期 1 天", color: "from-green-600 to-emerald-500", icon: "☀️" },
  { key: "weekly", label: "周卡", desc: "有效期 7 天", color: "from-blue-600 to-cyan-500", icon: "⭐" },
  { key: "monthly", label: "月卡", desc: "有效期 30 天", color: "from-purple-600 to-pink-500", icon: "👑" },
];

export default function CardKeyPage() {
  const { user, card, countdown, logout, refreshCard } = useAuth();
  const [, setLocation] = useLocation();
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<{ type: string; expiresAt: string } | null>(null);

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setError("");
    setLoading(true);
    try {
      const res = await api.card.activate(key.trim());
      setSuccess({ type: res.type, expiresAt: res.expiresAt });
      await refreshCard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "激活失败");
    } finally {
      setLoading(false);
    }
  };

  const typeLabel = (t: string) => CARD_TYPES.find(c => c.key === t)?.label ?? t;
  const expiryStr = (iso: string) => new Date(iso).toLocaleString("zh-CN");

  return (
    <div className="min-h-screen bg-[#0b0e1a] px-4 py-8">
      <div className="max-w-sm mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-xl font-bold text-white">激活卡密</h1>
            <p className="text-slate-400 text-sm mt-0.5">{user?.username}</p>
          </div>
          <button onClick={() => void logout()} className="text-slate-500 hover:text-slate-300 text-sm transition">
            退出
          </button>
        </div>

        {/* Active card countdown banner */}
        {card?.active && countdown && !success && (
          <div className={`rounded-2xl px-5 py-4 mb-5 border ${
            countdown.includes("天") || parseInt(countdown.split(":")[0] ?? "99") >= 1
              ? "bg-emerald-500/10 border-emerald-500/30"
              : "bg-red-500/10 border-red-500/30 animate-pulse"
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[11px] text-slate-400 mb-0.5">
                  {card.type === "daily" ? "☀️ 天卡" : card.type === "weekly" ? "⭐ 周卡" : "👑 月卡"} · 有效期至
                </div>
                <div className="text-[11px] text-slate-500">{expiryStr(card.expiresAt!)}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-slate-500 mb-0.5">剩余</div>
                <div className={`text-xl font-mono font-bold tabular-nums ${
                  !countdown.includes("天") && parseInt(countdown.split(":")[0] ?? "99") < 1
                    ? "text-red-400" : "text-emerald-400"
                }`}>{countdown}</div>
              </div>
            </div>
          </div>
        )}

        {success ? (
          <div className="bg-green-500/10 border border-green-500/30 rounded-2xl p-6 text-center mb-6">
            <div className="text-4xl mb-3">✅</div>
            <h3 className="text-green-400 font-bold text-lg mb-1">激活成功！</h3>
            <p className="text-slate-300 text-sm">
              {typeLabel(success.type)} · 有效期至 {expiryStr(success.expiresAt)}
            </p>
            <p className="text-slate-500 text-xs mt-3">正在跳转到主控台...</p>
          </div>
        ) : (
          <>
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-6 mb-6">
              <h2 className="text-white font-semibold mb-4">{card?.active ? "续费 / 更换卡密" : "输入卡密"}</h2>

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-4 py-3 mb-4">
                  {error}
                </div>
              )}

              <form onSubmit={handleActivate} className="space-y-3">
                <input
                  type="text"
                  value={key}
                  onChange={e => setKey(e.target.value.toUpperCase())}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition font-mono tracking-wider text-center text-lg"
                  maxLength={19}
                />
                <button
                  type="submit"
                  disabled={loading || !key.trim()}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold rounded-xl py-3 transition"
                >
                  {loading ? "激活中..." : "激 活"}
                </button>
              </form>
            </div>

            <div className="mb-6">
              <p className="text-slate-500 text-xs text-center mb-3">可用卡密类型</p>
              <div className="grid grid-cols-3 gap-2">
                {CARD_TYPES.map(t => (
                  <div key={t.key} className="bg-[#161929] border border-[#252a3d] rounded-xl p-3 text-center">
                    <div className="text-xl mb-1">{t.icon}</div>
                    <div className="text-white text-sm font-semibold">{t.label}</div>
                    <div className="text-slate-500 text-xs mt-0.5">{t.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {user?.isAdmin ? (
              <button
                onClick={() => setLocation("/admin")}
                className="w-full bg-[#161929] border border-[#252a3d] hover:border-blue-500/50 text-blue-400 text-sm font-semibold rounded-xl py-3 transition"
              >
                🔑 去后台生成卡密
              </button>
            ) : (
              <p className="text-center text-slate-600 text-xs">
                请联系管理员获取卡密
              </p>
            )}
          </>
        )}
      </div>
      <BottomNav />
    </div>
  );
}
