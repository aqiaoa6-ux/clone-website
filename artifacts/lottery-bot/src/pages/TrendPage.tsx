import { useEffect, useState, useCallback } from "react";
import { api, type LotteryData, type AlgoRate } from "../lib/api";
import BottomNav from "../components/BottomNav";

// ─── Types ────────────────────────────────────────────────────────────────────
interface DrawItem {
  term:  number;
  a:     number;
  b:     number;
  c:     number;
  sum:   number;
  big:   boolean;
  odd:   boolean;
}

// ─── Parse ────────────────────────────────────────────────────────────────────
function parseData(data: LotteryData): DrawItem[] {
  const raw = data.message?.all?.keno28?.data ?? [];
  return raw
    .filter(d => d.r3 && d.sum1 !== undefined)
    .slice(0, 100)
    .map(d => {
      const a = d.sum1 ?? 0;
      const b = d.sum2 ?? 0;
      const c = d.sum3 ?? 0;
      const sum = a + b + c;
      return { term: d.term, a, b, c, sum, big: sum >= 14, odd: sum % 2 !== 0 };
    });
}

// ─── Derived labels ───────────────────────────────────────────────────────────
function extreme(sum: number): { label: string; cls: string } {
  if (sum >= 22) return { label: "极大", cls: "text-rose-400" };
  if (sum <= 5)  return { label: "极小", cls: "text-blue-400" };
  return { label: "无", cls: "text-slate-500" };
}

function shape(a: number, b: number, c: number): { label: string; cls: string } {
  const vals = [a, b, c].sort((x, y) => x - y);
  if (a === b || b === c || a === c) return { label: "对子", cls: "text-amber-400" };
  if (vals[1]! - vals[0]! === 1 && vals[2]! - vals[1]! === 1)
    return { label: "顺子", cls: "text-emerald-400" };
  return { label: "杂六", cls: "text-slate-400" };
}

function dragonTiger(a: number, c: number): { label: string; cls: string } {
  if (a > c) return { label: "龙", cls: "text-rose-400" };
  if (a < c) return { label: "虎", cls: "text-blue-400" };
  return { label: "合", cls: "text-amber-400" };
}

function edgeRoad(sum: number): { label: string; cls: string } {
  if (sum >= 18) return { label: "大边", cls: "text-rose-400 font-semibold" };
  if (sum <= 9)  return { label: "小边", cls: "text-blue-400 font-semibold" };
  return { label: "中", cls: "text-slate-400" };
}

// ─── Ball component ───────────────────────────────────────────────────────────
function Ball({ n }: { n: number }) {
  const red = n >= 5;
  return (
    <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-white text-xs font-bold leading-none flex-shrink-0
      ${red ? "bg-rose-500" : "bg-blue-500"}`}>
      {n}
    </span>
  );
}

// ─── Streak helper ────────────────────────────────────────────────────────────
function streakInfo(items: DrawItem[]): string {
  if (!items.length) return "";
  const first = items[0]!;
  let count = 1;
  for (let i = 1; i < items.length; i++) {
    const cur = items[i]!;
    if (cur.big === first.big && cur.odd === first.odd) count++;
    else break;
  }
  const label = `${first.big ? "大" : "小"}${first.odd ? "单" : "双"}`;
  return count >= 2 ? `连${count}期${label}` : "";
}

// ─── Algo label map ───────────────────────────────────────────────────────────
const ALGO_LABELS: Record<string, string> = {
  adaptive_switch: "自适应", steady_ai: "升级AI", ai_trend: "AI趋势",
  streak_follow: "跟龙", dragon_ride: "顺龙", dragon_break: "破龙",
  momentum: "动量", anti_streak: "反连", cold_pick: "冷号",
};

// ─── Algo Rates Panel ─────────────────────────────────────────────────────────
function AlgoRatesPanel({ rates, historyCount }: { rates: AlgoRate[]; historyCount: number }) {
  if (!rates.length) {
    return (
      <div className="bg-[#0f1220] border border-[#1e2235] rounded-2xl px-4 py-5 text-center text-slate-600 text-xs">
        加载算法分析中…
      </div>
    );
  }
  return (
    <div className="bg-[#0f1220] border border-[#1e2235] rounded-2xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[#1e2235] flex items-center justify-between">
        <span className="text-white text-sm font-semibold">算法命中率</span>
        <span className="text-slate-600 text-[10px]">回测近 {historyCount} 期走势</span>
      </div>
      <div className="grid grid-cols-3 divide-x divide-[#1e2235]">
        {rates.map((r, i) => {
          const rate = r.simWinRate ? parseFloat(r.simWinRate) : null;
          const rateColor = rate === null ? "text-slate-500"
            : rate >= 55 ? "text-emerald-400"
            : rate >= 45 ? "text-yellow-400"
            : "text-red-400";
          const isBig = r.currentPrediction === "大";
          const isSmall = r.currentPrediction === "小";
          const rankBadge = i < 3
            ? ["text-yellow-400", "text-slate-300", "text-amber-600"][i]
            : "text-slate-600";
          return (
            <div key={r.algoId} className={`flex flex-col items-center py-3 px-1 gap-1 ${i % 3 !== 0 ? "" : ""}`}>
              <div className="flex items-center gap-1">
                <span className={`text-[9px] font-bold ${rankBadge}`}>#{i + 1}</span>
                <span className="text-white text-[11px] font-medium">{ALGO_LABELS[r.algoId] ?? r.algoId}</span>
              </div>
              {/* 当前预测方向 */}
              <div className={`text-base font-bold leading-none ${isBig ? "text-rose-400" : isSmall ? "text-blue-400" : "text-slate-600"}`}>
                {r.currentPrediction ?? "—"}
              </div>
              {/* 命中率 */}
              <div className={`text-sm font-bold ${rateColor}`}>
                {r.simWinRate ? `${r.simWinRate}%` : "—"}
              </div>
              <div className="text-slate-600 text-[9px]">
                {r.simTotal > 0 ? `${r.simWins}中/${r.simTotal}期` : "数据不足"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function TrendPage() {
  const [items,        setItems]        = useState<DrawItem[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [lastUpdated,  setLastUpdated]  = useState<Date | null>(null);
  const [algoRates,    setAlgoRates]    = useState<AlgoRate[]>([]);
  const [historyCount, setHistoryCount] = useState(0);

  const refreshRates = useCallback(async () => {
    try {
      const { rates, historyCount: hc } = await api.tg.algoRates();
      setAlgoRates(rates);
      setHistoryCount(hc);
    } catch { /* ignore */ }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api.lottery.fengpan();
      setItems(parseData(data));
      setLastUpdated(new Date());
    } catch { /* ignore */ }
    finally { setLoading(false); }
    void refreshRates();
  }, [refreshRates]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const display = items.slice(0, 50);
  const streak  = streakInfo(items);

  const fmt = (d: Date) =>
    `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;

  return (
    <div className="min-h-screen bg-[#0b0e1a] flex flex-col pb-20">

      {/* ── Header ── */}
      <div className="sticky top-0 z-30 bg-[#0b0e1a]/95 border-b border-[#1e2235] backdrop-blur px-4 py-3 flex items-center justify-between">
        <h1 className="text-white font-bold text-base">开奖走势</h1>
        <div className="flex items-center gap-2">
          {streak && (
            <span className="text-[11px] bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">{streak}</span>
          )}
          <span className="text-[10px] text-slate-500">
            {lastUpdated ? `${fmt(lastUpdated)} 更新` : "加载中..."}
          </span>
          <button onClick={() => void refresh()} className="text-slate-500 hover:text-slate-300 text-sm px-2">↻</button>
        </div>
      </div>

      <div className="px-3 py-3 space-y-3">

        {/* ── Algo rates ── */}
        <AlgoRatesPanel rates={algoRates} historyCount={historyCount} />

        {/* ── History table ── */}
        {loading ? (
          <div className="text-center text-slate-500 text-sm py-10">加载中...</div>
        ) : items.length === 0 ? (
          <div className="text-center text-slate-500 text-sm py-10">暂无数据</div>
        ) : (
          <div className="bg-[#0f1220] rounded-2xl overflow-hidden border border-[#1e2235]">
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse" style={{ minWidth: 480 }}>
                <thead>
                  <tr className="bg-[#131728] border-b border-[#1e2235]">
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">回合</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center" colSpan={2}>结果</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">双面</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">极值</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">形态</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">龙虎</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">边路</th>
                  </tr>
                </thead>
                <tbody>
                  {display.map((item, idx) => {
                    const ext = extreme(item.sum);
                    const shp = shape(item.a, item.b, item.c);
                    const dt  = dragonTiger(item.a, item.c);
                    const er  = edgeRoad(item.sum);
                    const isLatest = idx === 0;
                    return (
                      <tr
                        key={item.term}
                        className={`border-b border-[#1e2235]/50 ${isLatest ? "bg-blue-500/5" : "hover:bg-white/[0.015]"}`}
                      >
                        <td className="px-2 py-2 text-center whitespace-nowrap">
                          <span className={`text-[11px] ${isLatest ? "text-blue-300 font-semibold" : "text-slate-500"}`}>
                            {String(item.term).slice(-7)} 期
                          </span>
                        </td>
                        <td className="px-1 py-2 text-center">
                          <div className="flex items-center gap-1 justify-center">
                            <Ball n={item.a} />
                            <span className="text-slate-600 text-[10px]">+</span>
                            <Ball n={item.b} />
                            <span className="text-slate-600 text-[10px]">+</span>
                            <Ball n={item.c} />
                          </div>
                        </td>
                        <td className="px-2 py-2 text-center whitespace-nowrap">
                          <span className={`text-xs font-bold ${item.big ? "text-rose-400" : "text-blue-400"}`}>
                            = {item.sum}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <div className="flex items-center gap-1 justify-center">
                            <span className={`font-semibold text-xs ${item.big ? "text-rose-400" : "text-blue-400"}`}>
                              {item.big ? "大" : "小"}
                            </span>
                            <span className={`font-semibold text-xs ${item.odd ? "text-rose-300" : "text-emerald-400"}`}>
                              {item.odd ? "单" : "双"}
                            </span>
                          </div>
                        </td>
                        <td className={`px-2 py-2 text-center text-xs ${ext.cls}`}>{ext.label}</td>
                        <td className={`px-2 py-2 text-center text-xs ${shp.cls}`}>{shp.label}</td>
                        <td className={`px-2 py-2 text-center text-xs font-medium ${dt.cls}`}>{dt.label}</td>
                        <td className={`px-2 py-2 text-center text-xs ${er.cls}`}>{er.label}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="text-[10px] text-slate-600 text-center">
          显示近 {display.length} 期 · 每 30 秒自动刷新
        </p>
      </div>

      <BottomNav />
    </div>
  );
}
