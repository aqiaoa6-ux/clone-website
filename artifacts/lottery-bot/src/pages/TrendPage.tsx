import { useEffect, useState, useCallback } from "react";
import { api, type LotteryData, type CanadaSimHistoryRow, type CanadaSimSummary, type CanadaSimAlgoEntry } from "../lib/api";
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

const CANADA_SIM_ORDER = [
  "canada_pro_1",
  "canada_pro_2",
  "canada_pro_3",
  "canada_pro_4",
  "canada_pro_5",
  "canada_pro_6",
  "canada_pro_7",
  "canada_pro_8",
  "canada_pro_9",
  "canada_pro_10",
] as const;

const CANADA_SIM_LABELS: Record<(typeof CANADA_SIM_ORDER)[number], string> = {
  canada_pro_1: "算法1",
  canada_pro_2: "算法2",
  canada_pro_3: "算法3",
  canada_pro_4: "算法4",
  canada_pro_5: "算法5",
  canada_pro_6: "算法6",
  canada_pro_7: "算法7",
  canada_pro_8: "算法8",
  canada_pro_9: "算法9",
  canada_pro_10: "算法10",
};

function fmtCurrentStreak(streak: number): string {
  if (streak > 0) return `${streak}连中`;
  if (streak < 0) return `${Math.abs(streak)}连未`;
  return "无连";
}

function drawLabel(item: DrawItem): string {
  return `${item.big ? "大" : "小"}${item.odd ? "单" : "双"}`;
}

function SimCell({ entry }: { entry?: CanadaSimAlgoEntry }) {
  if (!entry) return <span className="text-[10px] text-slate-600">-</span>;
  const isWin = entry.won === true;
  const isLoss = entry.won === false;
  const badgeCls = entry.skipped
    ? "bg-slate-500/15 text-slate-400"
    : isWin
      ? "bg-emerald-500/15 text-emerald-400"
      : isLoss
        ? "bg-rose-500/15 text-rose-400"
        : "bg-slate-500/15 text-slate-400";
  const badgeText = entry.skipped ? "跳" : isWin ? "中" : isLoss ? "未" : "-";
  const streakText = entry.skipped || entry.streak === 0 ? "" : entry.streak > 0 ? `中${entry.streak}` : `未${Math.abs(entry.streak)}`;

  return (
    <div className="flex flex-col items-center gap-1">
      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${badgeCls}`}>{badgeText}</span>
      {streakText && <span className="text-[10px] text-slate-500 whitespace-nowrap">{streakText}</span>}
      {entry.prediction && <span className="text-[10px] text-slate-600 whitespace-nowrap">{entry.prediction}</span>}
    </div>
  );
}

function getBestAlgoForRow(row: CanadaSimHistoryRow | undefined, summaryMap: Map<string, CanadaSimSummary>) {
  if (!row) return null;
  const winners = row.algos.filter(entry => entry.won === true && !entry.skipped);
  if (winners.length === 0) return null;
  return [...winners].sort((a, b) => {
    const aStat = summaryMap.get(a.algoId);
    const bStat = summaryMap.get(b.algoId);
    const aRate = aStat?.winRate ? Number(aStat.winRate) : 0;
    const bRate = bStat?.winRate ? Number(bStat.winRate) : 0;
    if (bRate !== aRate) return bRate - aRate;
    const aStreak = aStat?.currentStreak ?? 0;
    const bStreak = bStat?.currentStreak ?? 0;
    if (bStreak !== aStreak) return bStreak - aStreak;
    const aMax = aStat?.maxWinStreak ?? 0;
    const bMax = bStat?.maxWinStreak ?? 0;
    if (bMax !== aMax) return bMax - aMax;
    return a.algoId.localeCompare(b.algoId, "zh-CN");
  })[0] ?? null;
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function TrendPage() {
  const [items,       setItems]       = useState<DrawItem[]>([]);
  const [simRows,     setSimRows]     = useState<CanadaSimHistoryRow[]>([]);
  const [simSummary,  setSimSummary]  = useState<CanadaSimSummary[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [lotteryRes, simRes] = await Promise.allSettled([
        api.lottery.fengpan(),
        api.tg.canadaSimHistory(),
      ]);
      if (lotteryRes.status === "fulfilled") {
        const data = lotteryRes.value as LotteryData;
        setItems(parseData(data));
      }
      if (simRes.status === "fulfilled") {
        setSimRows(simRes.value.rows);
        setSimSummary(simRes.value.summary);
      }
      setLastUpdated(new Date());
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const display = items.slice(0, 50);
  const streak  = streakInfo(items);
  const summaryMap = new Map(simSummary.map(item => [item.algoId, item]));

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

        {simSummary.length > 0 && (
          <div className="bg-[#0f1220] rounded-2xl border border-[#1e2235] p-3">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-white text-sm font-semibold">加拿大算法1-10 模拟回测</h2>
              <span className="text-[10px] text-slate-500">基于近期开奖历史逐期模拟</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 xl:grid-cols-10 gap-2">
              {CANADA_SIM_ORDER.map(algoId => {
                const stat = summaryMap.get(algoId);
                return (
                  <div key={algoId} className="rounded-xl border border-[#1e2235] bg-[#111526] p-2.5">
                    <div className="text-[11px] text-slate-400">{CANADA_SIM_LABELS[algoId]}</div>
                    <div className="text-sm font-bold text-white mt-1">{stat?.winRate ? `${stat.winRate}%` : "-"}</div>
                    <div className="text-[10px] text-slate-500 mt-1">{stat ? fmtCurrentStreak(stat.currentStreak) : "暂无"}</div>
                    <div className="text-[10px] text-slate-600 mt-1">
                      {stat ? `${stat.wins}中/${stat.losses}未/${stat.skips}跳` : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── History table ── */}
        {loading ? (
          <div className="text-center text-slate-500 text-sm py-10">加载中...</div>
        ) : items.length === 0 ? (
          <div className="text-center text-slate-500 text-sm py-10">暂无数据</div>
        ) : (
          <div className="bg-[#0f1220] rounded-2xl overflow-hidden border border-[#1e2235]">
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse" style={{ minWidth: 1480 }}>
                <thead>
                  <tr className="bg-[#131728] border-b border-[#1e2235]">
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">回合</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center" colSpan={2}>结果</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">双面</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">极值</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">形态</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">龙虎</th>
                    <th className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">边路</th>
                    {CANADA_SIM_ORDER.map(algoId => (
                      <th key={algoId} className="text-slate-400 font-medium px-2 py-2.5 text-center whitespace-nowrap">
                        {CANADA_SIM_LABELS[algoId]}
                      </th>
                    ))}
                    <th className="text-amber-300 font-medium px-2 py-2.5 text-center whitespace-nowrap">本期最佳算法</th>
                  </tr>
                </thead>
                <tbody>
                  {display.map((item, idx) => {
                    const ext = extreme(item.sum);
                    const shp = shape(item.a, item.b, item.c);
                    const dt  = dragonTiger(item.a, item.c);
                    const er  = edgeRoad(item.sum);
                    const isLatest = idx === 0;
                    const actual = drawLabel(item);
                    const simRow = simRows[idx] && simRows[idx]!.actual === actual ? simRows[idx]! : simRows[idx];
                    const simMap = new Map((simRow?.algos ?? []).map(entry => [entry.algoId, entry]));
                    const bestAlgo = getBestAlgoForRow(simRow, summaryMap);
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
                        {CANADA_SIM_ORDER.map(algoId => (
                          <td key={algoId} className="px-2 py-2 text-center">
                            <SimCell entry={simMap.get(algoId)} />
                          </td>
                        ))}
                        <td className="px-2 py-2 text-center">
                          {bestAlgo ? (
                            <div className="flex flex-col items-center gap-1">
                              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-300 whitespace-nowrap">
                                {CANADA_SIM_LABELS[bestAlgo.algoId as keyof typeof CANADA_SIM_LABELS]}
                              </span>
                              {bestAlgo.prediction && <span className="text-[10px] text-amber-100/80 whitespace-nowrap">{bestAlgo.prediction}</span>}
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-500">本期全未</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="text-[10px] text-slate-600 text-center">
          显示近 {display.length} 期 · 含加拿大算法1-10逐期模拟回测 · 每 30 秒自动刷新
        </p>
      </div>

      <BottomNav />
    </div>
  );
}
