import { useCallback, useEffect, useRef, useState } from "react";
import { api, type LotteryData } from "../lib/api";
import BottomNav from "../components/BottomNav";

interface DrawItem {
  term: number;
  a: number;
  b: number;
  c: number;
  sum: number;
  big: boolean;
  odd: boolean;
}

function parseData(data: LotteryData): DrawItem[] {
  const raw = data.message?.all?.keno28?.data ?? [];
  return raw
    .filter(item => item.r3 && item.sum1 !== undefined)
    .slice(0, 100)
    .map(item => {
      const a = item.sum1 ?? 0;
      const b = item.sum2 ?? 0;
      const c = item.sum3 ?? 0;
      const sum = a + b + c;
      return { term: item.term, a, b, c, sum, big: sum >= 14, odd: sum % 2 !== 0 };
    });
}

function extreme(sum: number): { label: string; cls: string } {
  if (sum >= 22) return { label: "极大", cls: "text-rose-400" };
  if (sum <= 5) return { label: "极小", cls: "text-blue-400" };
  return { label: "无", cls: "text-slate-500" };
}

function shape(a: number, b: number, c: number): { label: string; cls: string } {
  const vals = [a, b, c].sort((x, y) => x - y);
  if (a === b || b === c || a === c) return { label: "对子", cls: "text-amber-400" };
  if (vals[1]! - vals[0]! === 1 && vals[2]! - vals[1]! === 1) {
    return { label: "顺子", cls: "text-emerald-400" };
  }
  return { label: "杂六", cls: "text-slate-400" };
}

function dragonTiger(a: number, c: number): { label: string; cls: string } {
  if (a > c) return { label: "龙", cls: "text-rose-400" };
  if (a < c) return { label: "虎", cls: "text-blue-400" };
  return { label: "合", cls: "text-amber-400" };
}

function edgeRoad(sum: number): { label: string; cls: string } {
  if (sum >= 18) return { label: "大边", cls: "text-rose-400 font-semibold" };
  if (sum <= 9) return { label: "小边", cls: "text-blue-400 font-semibold" };
  return { label: "中", cls: "text-slate-400" };
}

function Ball({ n }: { n: number }) {
  const red = n >= 5;
  return (
    <span
      className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold leading-none text-white ${
        red ? "bg-rose-500" : "bg-blue-500"
      }`}
    >
      {n}
    </span>
  );
}

function streakInfo(items: DrawItem[]): string {
  if (!items.length) return "";
  const first = items[0]!;
  let count = 1;
  for (let i = 1; i < items.length; i++) {
    const current = items[i]!;
    if (current.big === first.big && current.odd === first.odd) count++;
    else break;
  }
  const label = `${first.big ? "大" : "小"}${first.odd ? "单" : "双"}`;
  return count >= 2 ? `连${count}期${label}` : "";
}

export default function TrendPage() {
  const [items, setItems] = useState<DrawItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const refreshInFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const data = await api.lottery.fengpan();
      setItems(parseData(data as LotteryData));
      setLastUpdated(new Date());
    } catch {
      // ignore refresh failures and keep current data
    } finally {
      refreshInFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const display = items.slice(0, 50);
  const streak = streakInfo(items);

  const fmt = (date: Date) =>
    `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`;

  return (
    <div className="min-h-screen bg-[#0b0e1a] pb-28">
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-[#1e2235] bg-[#0b0e1a]/95 px-4 py-3 backdrop-blur">
        <h1 className="text-base font-bold text-white">开奖走势</h1>
        <div className="flex items-center gap-2">
          {streak && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-400">{streak}</span>
          )}
          <span className="text-[10px] text-slate-500">{lastUpdated ? `${fmt(lastUpdated)} 更新` : "加载中..."}</span>
          <button onClick={() => void refresh()} className="px-2 text-sm text-slate-500 hover:text-slate-300">
            ↻
          </button>
        </div>
      </div>

      <div className="space-y-3 px-3 py-3">
        {loading ? (
          <div className="py-10 text-center text-sm text-slate-500">加载中...</div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-500">暂无数据</div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-[#1e2235] bg-[#0f1220]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[#1e2235] bg-[#131728]">
                    <th className="whitespace-nowrap px-2 py-2.5 text-center font-medium text-slate-400">回合</th>
                    <th className="px-2 py-2.5 text-center font-medium text-slate-400" colSpan={2}>
                      结果
                    </th>
                    <th className="whitespace-nowrap px-2 py-2.5 text-center font-medium text-slate-400">双面</th>
                    <th className="whitespace-nowrap px-2 py-2.5 text-center font-medium text-slate-400">极值</th>
                    <th className="whitespace-nowrap px-2 py-2.5 text-center font-medium text-slate-400">形态</th>
                    <th className="whitespace-nowrap px-2 py-2.5 text-center font-medium text-slate-400">龙虎</th>
                    <th className="whitespace-nowrap px-2 py-2.5 text-center font-medium text-slate-400">边路</th>
                  </tr>
                </thead>
                <tbody>
                  {display.map((item, index) => {
                    const ext = extreme(item.sum);
                    const shp = shape(item.a, item.b, item.c);
                    const dt = dragonTiger(item.a, item.c);
                    const er = edgeRoad(item.sum);
                    const isLatest = index === 0;
                    return (
                      <tr
                        key={item.term}
                        className={`border-b border-[#1e2235]/50 ${isLatest ? "bg-blue-500/5" : "hover:bg-white/[0.015]"}`}
                      >
                        <td className="px-2 py-2 text-center whitespace-nowrap">
                          <span className={`text-[11px] ${isLatest ? "font-semibold text-blue-300" : "text-slate-500"}`}>
                            {String(item.term).slice(-7)} 期
                          </span>
                        </td>
                        <td className="px-1 py-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <Ball n={item.a} />
                            <span className="text-[10px] text-slate-600">+</span>
                            <Ball n={item.b} />
                            <span className="text-[10px] text-slate-600">+</span>
                            <Ball n={item.c} />
                          </div>
                        </td>
                        <td className="px-2 py-2 text-center whitespace-nowrap">
                          <span className={`text-xs font-bold ${item.big ? "text-rose-400" : "text-blue-400"}`}>= {item.sum}</span>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <span className={`text-xs font-semibold ${item.big ? "text-rose-400" : "text-blue-400"}`}>
                              {item.big ? "大" : "小"}
                            </span>
                            <span className={`text-xs font-semibold ${item.odd ? "text-rose-300" : "text-emerald-400"}`}>
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

        <p className="text-center text-[10px] text-slate-600">显示近 {display.length} 期 · 每 30 秒自动刷新</p>
      </div>

      <BottomNav />
    </div>
  );
}
