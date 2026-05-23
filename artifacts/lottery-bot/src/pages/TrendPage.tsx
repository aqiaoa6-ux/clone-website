import { useEffect, useState, useCallback } from "react";
import { api, type LotteryData } from "../lib/api";
import BottomNav from "../components/BottomNav";

// ─── Types ────────────────────────────────────────────────────────────────────
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
  { key: "big",        label: "大",   color: "text-rose-400",    bg: "bg-rose-500/20",    dot: "bg-rose-400",    warn: 15 },
  { key: "small",      label: "小",   color: "text-blue-400",    bg: "bg-blue-500/20",    dot: "bg-blue-400",    warn: 15 },
  { key: "odd",        label: "单",   color: "text-amber-400",   bg: "bg-amber-500/20",   dot: "bg-amber-400",   warn: 15 },
  { key: "even",       label: "双",   color: "text-emerald-400", bg: "bg-emerald-500/20", dot: "bg-emerald-400", warn: 15 },
  { key: "big-odd",    label: "大单", color: "text-rose-300",    bg: "bg-rose-500/10",    dot: "bg-rose-300",    warn: 20 },
  { key: "big-even",   label: "大双", color: "text-purple-400",  bg: "bg-purple-500/10",  dot: "bg-purple-400",  warn: 20 },
  { key: "small-odd",  label: "小单", color: "text-cyan-400",    bg: "bg-cyan-500/10",    dot: "bg-cyan-400",    warn: 20 },
  { key: "small-even", label: "小双", color: "text-teal-400",    bg: "bg-teal-500/10",    dot: "bg-teal-400",    warn: 20 },
] as const;

type ColKey = typeof COLS[number]["key"];

// ─── Helpers ──────────────────────────────────────────────────────────────────
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
    .slice(-100)   // keep up to 100 periods for better missing stats
    .reverse()     // newest first
    .map(d => {
      const sum = (d.sum1 ?? 0) + (d.sum2 ?? 0) + (d.sum3 ?? 0);
      const r3 = d.r3!;
      return {
        term: d.term,
        sum,
        r3,
        isBig:   r3.startsWith("大"),
        isSmall: r3.startsWith("小"),
        isOdd:   r3.endsWith("单"),
        isEven:  r3.endsWith("双"),
      };
    });
}

/**
 * Build a 2-D grid of missing counts.
 * grid[rowIdx][colIdx] = null means "hit this period (show dot)"
 *                       = number means "N consecutive periods since last hit"
 * Processes oldest→newest so the count naturally accumulates.
 */
function buildMissingGrid(items: DrawItem[]): (number | null)[][] {
  const n = items.length;
  const c = COLS.length;
  const grid: (number | null)[][] = Array.from({ length: n }, () =>
    Array<number | null>(c).fill(0)
  );
  const counters = Array<number>(c).fill(0);

  for (let i = n - 1; i >= 0; i--) {           // oldest → newest
    COLS.forEach((col, ci) => {
      if (matchesCol(items[i], col.key as ColKey)) {
        grid[i][ci] = null;                     // hit
        counters[ci] = 0;
      } else {
        counters[ci]++;
        grid[i][ci] = counters[ci];
      }
    });
  }
  return grid;
}

/** Current missing count = number of consecutive non-hits from newest. */
function currentMissing(items: DrawItem[], key: ColKey): number {
  for (let i = 0; i < items.length; i++) {
    if (matchesCol(items[i], key)) return i;
  }
  return items.length;
}

/** Max missing in the full grid for one column. */
function maxMissing(grid: (number | null)[][], ci: number): number {
  let max = 0;
  for (const row of grid) {
    const v = row[ci];
    if (v !== null && v > max) max = v;
  }
  return max;
}

function streakInfo(items: DrawItem[]): string {
  if (!items.length) return "";
  const first = items[0];
  let count = 1;
  for (let i = 1; i < items.length; i++) {
    const cur = items[i];
    if (
      ((first.isBig && cur.isBig) || (first.isSmall && cur.isSmall)) &&
      ((first.isOdd && cur.isOdd) || (first.isEven && cur.isEven))
    ) count++;
    else break;
  }
  return count >= 2 ? `连${count}期${first.r3}` : "";
}

// ─── Components ───────────────────────────────────────────────────────────────
function MissingBadge({ val, warn }: { val: number; warn: number }) {
  const hot  = val >= warn;
  const warm = val >= Math.round(warn * 0.7);
  const cls  = hot  ? "text-orange-400 font-bold"
             : warm ? "text-yellow-400 font-semibold"
             :        "text-slate-500";
  return <span className={`text-[11px] leading-none ${cls}`}>{val}</span>;
}

export default function TrendPage() {
  const [items,       setItems]       = useState<DrawItem[]>([]);
  const [grid,        setGrid]        = useState<(number | null)[][]>([]);
  const [loading,     setLoading]     = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.lottery.fengpan();
      const parsed = parseData(data);
      setItems(parsed);
      setGrid(buildMissingGrid(parsed));
      setLastUpdated(new Date());
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const streak   = streakInfo(items);
  const display  = items.slice(0, 50);              // show newest 50 rows

  // Per-column stats
  const colStats = COLS.map((col, ci) => ({
    col,
    ci,
    count:   items.filter(i => matchesCol(i, col.key as ColKey)).length,
    current: currentMissing(items, col.key as ColKey),
    max:     maxMissing(grid, ci),
  }));

  // Missing leaderboard — sorted by current missing desc
  const leaderboard = [...colStats].sort((a, b) => b.current - a.current);

  const fmt = (d: Date) =>
    `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}:${d.getSeconds().toString().padStart(2,"0")}`;

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

      <div className="px-4 py-3 space-y-3">

        {/* ── 出现统计 ── */}
        <div>
          <p className="text-[11px] text-slate-500 mb-2">近 {items.length} 期出现次数</p>
          <div className="grid grid-cols-4 gap-2">
            {colStats.map(({ col, count }) => (
              <div key={col.key} className={`rounded-xl p-2.5 flex flex-col items-center gap-0.5 bg-[#131728]`}>
                <span className={`text-[11px] font-semibold ${col.color}`}>{col.label}</span>
                <span className={`text-lg font-bold ${col.color}`}>{count}</span>
                <span className="text-[10px] text-slate-500">
                  {items.length ? Math.round(count * 100 / items.length) : 0}%
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── 遗漏排行 ── */}
        <div>
          <p className="text-[11px] text-slate-500 mb-2">当前遗漏排行（越大越久未开）</p>
          <div className="bg-[#0f1220] rounded-2xl border border-[#1e2235] overflow-hidden">
            {leaderboard.map(({ col, current, max }, rank) => {
              const pct = max > 0 ? Math.round(current / max * 100) : 0;
              const hot  = current >= col.warn;
              const warm = current >= Math.round(col.warn * 0.7);
              const barColor = hot  ? "bg-orange-500"
                             : warm ? "bg-yellow-500"
                             :        "bg-blue-600";
              return (
                <div
                  key={col.key}
                  className={`flex items-center gap-3 px-4 py-2.5 border-b border-[#1e2235]/60 last:border-0 ${hot ? "bg-orange-500/5" : ""}`}
                >
                  {/* Rank */}
                  <span className="text-[11px] text-slate-600 w-4 text-right flex-shrink-0">#{rank + 1}</span>
                  {/* Label */}
                  <span className={`text-xs font-semibold w-8 flex-shrink-0 ${col.color}`}>{col.label}</span>
                  {/* Bar */}
                  <div className="flex-1 h-1.5 bg-[#1e2235] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${barColor}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {/* Current missing */}
                  <span className={`text-sm font-bold w-8 text-right flex-shrink-0 ${hot ? "text-orange-400" : warm ? "text-yellow-400" : "text-slate-300"}`}>
                    {current}
                  </span>
                  {/* Max */}
                  <span className="text-[10px] text-slate-600 w-12 text-right flex-shrink-0">最高{max}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── 走势表格 ── */}
        {loading ? (
          <div className="text-center text-slate-500 text-sm py-10">加载中...</div>
        ) : items.length === 0 ? (
          <div className="text-center text-slate-500 text-sm py-10">暂无数据</div>
        ) : (
          <div>
            <p className="text-[11px] text-slate-500 mb-2">近 {display.length} 期走势（列头数字 = 当前遗漏）</p>
            <div className="bg-[#0f1220] rounded-2xl overflow-hidden border border-[#1e2235]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[540px] text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#131728] border-b border-[#1e2235]">
                      <th className="text-left text-slate-400 font-medium px-3 py-2 w-[76px]">期号</th>
                      <th className="text-center text-slate-400 font-medium px-2 py-2 w-[40px]">和值</th>
                      {colStats.map(({ col, current }) => (
                        <th key={col.key} className="text-center px-1 py-1.5 w-[48px]">
                          <div className="flex flex-col items-center gap-0.5">
                            <span className={`font-semibold leading-none ${col.color}`}>{col.label}</span>
                            <MissingBadge val={current} warn={col.warn} />
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {display.map((item, rowIdx) => (
                      <tr
                        key={item.term}
                        className={`border-b border-[#1e2235]/60 transition-colors ${rowIdx === 0 ? "bg-blue-500/5" : "hover:bg-white/[0.02]"}`}
                      >
                        {/* Period */}
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            {rowIdx === 0 && (
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
                            )}
                            <span className={rowIdx === 0 ? "text-blue-300 font-semibold" : "text-slate-500"}>
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
                        {COLS.map((col, ci) => {
                          const cell = grid[rowIdx]?.[ci];
                          const hit  = cell === null;
                          return (
                            <td
                              key={col.key}
                              className={`px-1 py-2 text-center ${hit ? col.bg : ""}`}
                            >
                              {hit ? (
                                <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${col.dot} text-white text-[10px] font-bold leading-none`}>
                                  ●
                                </span>
                              ) : (
                                <span className={`text-[11px] leading-none ${
                                  typeof cell === "number" && cell >= col.warn     ? "text-orange-400 font-bold" :
                                  typeof cell === "number" && cell >= Math.round(col.warn * 0.7) ? "text-yellow-500" :
                                  "text-slate-700"
                                }`}>
                                  {cell}
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
          </div>
        )}

        {/* ── Legend ── */}
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-1">
            {COLS.map(c => (
              <div key={c.key} className="flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-full ${c.dot}`} />
                <span className={`text-[11px] ${c.color}`}>{c.label}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4 px-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-orange-400 font-bold">18</span>
              <span className="text-[10px] text-slate-600">高遗漏预警</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-yellow-500">12</span>
              <span className="text-[10px] text-slate-600">中度遗漏</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-slate-700">3</span>
              <span className="text-[10px] text-slate-600">正常遗漏</span>
            </div>
          </div>
        </div>

        <p className="text-[10px] text-slate-600 text-center">
          显示近 {display.length} 期 · 统计基于近 {items.length} 期 · 每 30 秒自动刷新
        </p>
      </div>

      <BottomNav />
    </div>
  );
}
