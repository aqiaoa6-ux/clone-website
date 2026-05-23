import { useEffect, useState, useCallback } from "react";
import { api, type LotteryData } from "../lib/api";
import BottomNav from "../components/BottomNav";

interface DrawItem {
  term: number;
  sum: number;
  r3: string;
  isBig: boolean;
  isSmall: boolean;
  isOdd: boolean;
  isEven: boolean;
}

const COLS = [
  { key: "big",       label: "大", color: "text-rose-400",   bg: "bg-rose-500/20",   dot: "bg-rose-400" },
  { key: "small",     label: "小", color: "text-blue-400",   bg: "bg-blue-500/20",   dot: "bg-blue-400" },
  { key: "odd",       label: "单", color: "text-amber-400",  bg: "bg-amber-500/20",  dot: "bg-amber-400" },
  { key: "even",      label: "双", color: "text-emerald-400",bg: "bg-emerald-500/20",dot: "bg-emerald-400" },
  { key: "big-odd",   label: "大单",color: "text-rose-300",  bg: "bg-rose-500/10",   dot: "bg-rose-300" },
  { key: "big-even",  label: "大双",color: "text-purple-400",bg: "bg-purple-500/10", dot: "bg-purple-400" },
  { key: "small-odd", label: "小单",color: "text-cyan-400",  bg: "bg-cyan-500/10",   dot: "bg-cyan-400" },
  { key: "small-even",label: "小双",color: "text-teal-400",  bg: "bg-teal-500/10",   dot: "bg-teal-400" },
] as const;

type ColKey = typeof COLS[number]["key"];

function classify(r3: string, sum: number): Omit<DrawItem, "term" | "sum" | "r3"> {
  const isBig   = r3.startsWith("大") || (r3 === "" && sum >= 14);
  const isSmall  = r3.startsWith("小") || (r3 === "" && sum < 14);
  const isOdd    = r3.endsWith("单") || (r3 === "" && sum % 2 === 1);
  const isEven   = r3.endsWith("双") || (r3 === "" && sum % 2 === 0);
  return { isBig, isSmall, isOdd, isEven };
}

function matchesCol(item: DrawItem, key: ColKey): boolean {
  switch (key) {
    case "big":        return item.isBig;
    case "small":      return item.isSmall;
    case "odd":        return item.isOdd;
    case "even":       return item.isEven;
    case "big-odd":    return item.isBig && item.isOdd;
    case "big-even":   return item.isBig && item.isEven;
    case "small-odd":  return item.isSmall && item.isOdd;
    case "small-even": return item.isSmall && item.isEven;
  }
}

function parseData(data: LotteryData): DrawItem[] {
  const raw = data.message?.all?.keno28?.data ?? [];
  return raw
    .filter(d => d.r3)
    .slice(-50)
    .reverse()
    .map(d => {
      const sum = (d.sum1 ?? 0) + (d.sum2 ?? 0) + (d.sum3 ?? 0);
      const cls = classify(d.r3!, sum);
      return { term: d.term, sum, r3: d.r3!, ...cls };
    });
}

function streakInfo(items: DrawItem[]): string {
  if (!items.length) return "";
  const last = items[0];
  let count = 1;
  for (let i = 1; i < items.length; i++) {
    const cur = items[i];
    const sameBS = (last.isBig && cur.isBig) || (last.isSmall && cur.isSmall);
    const sameOE = (last.isOdd && cur.isOdd) || (last.isEven && cur.isEven);
    if (sameBS && sameOE) count++;
    else break;
  }
  if (count < 2) return "";
  return `连续 ${count} 期 ${last.r3}`;
}

function StatBox({ label, val, sub, color }: { label: string; val: number; sub: string; color: string }) {
  return (
    <div className="bg-[#131728] rounded-xl p-3 flex flex-col items-center gap-0.5">
      <span className="text-[10px] text-slate-500">{label}</span>
      <span className={`text-xl font-bold ${color}`}>{val}</span>
      <span className="text-[10px] text-slate-400">{sub}</span>
    </div>
  );
}

export default function TrendPage() {
  const [items, setItems] = useState<DrawItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.lottery.fengpan();
      setItems(parseData(data));
      setLastUpdated(new Date());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const bigCount   = items.filter(i => i.isBig).length;
  const smallCount = items.filter(i => i.isSmall).length;
  const oddCount   = items.filter(i => i.isOdd).length;
  const evenCount  = items.filter(i => i.isEven).length;
  const streak     = streakInfo(items);

  return (
    <div className="min-h-screen bg-[#0b0e1a] flex flex-col pb-20">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-[#0b0e1a]/95 border-b border-[#1e2235] backdrop-blur px-4 py-3 flex items-center justify-between">
        <h1 className="text-white font-bold text-base">开奖走势</h1>
        <div className="flex items-center gap-2">
          {streak && (
            <span className="text-[11px] bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">{streak}</span>
          )}
          <span className="text-[10px] text-slate-500">
            {lastUpdated ? `${lastUpdated.getHours().toString().padStart(2,"0")}:${lastUpdated.getMinutes().toString().padStart(2,"0")}:${lastUpdated.getSeconds().toString().padStart(2,"0")} 更新` : "加载中..."}
          </span>
          <button onClick={() => void refresh()} className="text-slate-500 hover:text-slate-300 text-sm px-2">↻</button>
        </div>
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-2">
          <StatBox label="大" val={bigCount}   sub={`${items.length ? Math.round(bigCount*100/items.length) : 0}%`}   color="text-rose-400" />
          <StatBox label="小" val={smallCount} sub={`${items.length ? Math.round(smallCount*100/items.length) : 0}%`} color="text-blue-400" />
          <StatBox label="单" val={oddCount}   sub={`${items.length ? Math.round(oddCount*100/items.length) : 0}%`}   color="text-amber-400" />
          <StatBox label="双" val={evenCount}  sub={`${items.length ? Math.round(evenCount*100/items.length) : 0}%`}  color="text-emerald-400" />
        </div>

        {/* Combo stats */}
        <div className="grid grid-cols-4 gap-2">
          {(["big-odd","big-even","small-odd","small-even"] as ColKey[]).map(k => {
            const col = COLS.find(c => c.key === k)!;
            const cnt = items.filter(i => matchesCol(i, k)).length;
            return (
              <div key={k} className={`rounded-xl p-2 flex flex-col items-center gap-0.5 ${col.bg}`}>
                <span className={`text-xs font-semibold ${col.color}`}>{col.label}</span>
                <span className={`text-base font-bold ${col.color}`}>{cnt}</span>
                <span className="text-[10px] text-slate-500">{items.length ? Math.round(cnt*100/items.length) : 0}%</span>
              </div>
            );
          })}
        </div>

        {/* Trend table */}
        {loading ? (
          <div className="text-center text-slate-500 text-sm py-10">加载中...</div>
        ) : items.length === 0 ? (
          <div className="text-center text-slate-500 text-sm py-10">暂无数据</div>
        ) : (
          <div className="bg-[#0f1220] rounded-2xl overflow-hidden border border-[#1e2235]">
            {/* Table header */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-xs border-collapse">
                <thead>
                  <tr className="bg-[#131728] border-b border-[#1e2235]">
                    <th className="text-left text-slate-400 font-medium px-3 py-2 w-[80px]">期号</th>
                    <th className="text-center text-slate-400 font-medium px-2 py-2 w-[44px]">和值</th>
                    {COLS.map(c => (
                      <th key={c.key} className={`text-center font-semibold px-2 py-2 w-[48px] ${c.color}`}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => (
                    <tr
                      key={item.term}
                      className={`border-b border-[#1e2235]/60 transition-colors ${idx === 0 ? "bg-blue-500/5" : "hover:bg-white/[0.02]"}`}
                    >
                      {/* Period */}
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          {idx === 0 && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />}
                          <span className={idx === 0 ? "text-blue-300 font-semibold" : "text-slate-400"}>
                            {String(item.term).slice(-6)}
                          </span>
                        </div>
                      </td>
                      {/* Sum */}
                      <td className="px-2 py-2 text-center">
                        <span className={`font-bold ${item.sum >= 14 ? "text-rose-400" : "text-blue-400"}`}>
                          {item.sum}
                        </span>
                      </td>
                      {/* Outcome columns */}
                      {COLS.map(c => {
                        const hit = matchesCol(item, c.key as ColKey);
                        return (
                          <td key={c.key} className={`px-2 py-2 text-center ${hit ? c.bg : ""}`}>
                            {hit && (
                              <span className={`inline-block w-4 h-4 rounded-full ${c.dot} text-[9px] flex items-center justify-center text-white font-bold leading-none`}>
                                ●
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-1">
          {COLS.map(c => (
            <div key={c.key} className="flex items-center gap-1.5">
              <span className={`w-2.5 h-2.5 rounded-full ${c.dot}`} />
              <span className={`text-[11px] ${c.color}`}>{c.label}</span>
            </div>
          ))}
        </div>

        <p className="text-[10px] text-slate-600 text-center">显示最近 {items.length} 期 · 每 30 秒自动刷新</p>
      </div>

      <BottomNav />
    </div>
  );
}
