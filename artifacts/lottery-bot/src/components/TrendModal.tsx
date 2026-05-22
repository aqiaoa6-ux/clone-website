import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, RefreshCw, TrendingUp, BarChart3 } from 'lucide-react';

export interface LotteryTerm {
  term: number;
  result: number;
  sum1: number;
  sum2: number;
  sum3: number;
  r1: string;
  r2: string;
  r3: string;
  openTime: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  initialItems?: LotteryTerm[];
}

const BLUE = [0, 1, 3, 4, 9, 10, 14, 15, 20];
const GREEN = [6, 11, 16, 17, 21, 22];

function ballColor(n: number) {
  if (BLUE.includes(n)) return '#4CA2FF';
  if (GREEN.includes(n)) return '#10b981';
  return '#f44336';
}

function Ball({ n, size = 22 }: { n: number; size?: number }) {
  const c = ballColor(n);
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-bold"
      style={{
        width: size, height: size, fontSize: size * 0.45,
        background: c + '22', border: `1px solid ${c}55`, color: c,
        flexShrink: 0,
      }}
    >
      {n}
    </span>
  );
}

function ResultBadge({ label }: { label: string }) {
  const colorMap: Record<string, string> = {
    '大': '#f44336', '小': '#4CA2FF',
    '单': '#c8a520', '双': '#10b981',
    '大单': '#f44336', '大双': '#e040fb',
    '小单': '#4CA2FF', '小双': '#10b981',
  };
  const c = colorMap[label] ?? '#888';
  return (
    <span className="inline-flex items-center justify-center rounded text-[10px] font-bold px-1"
      style={{ background: c + '22', color: c, border: `1px solid ${c}44`, minWidth: 26 }}>
      {label}
    </span>
  );
}

// Streak dot in trend grid
function Dot({ active, color }: { active: boolean; color: string }) {
  if (!active) return <span className="w-4 h-4 inline-block" />;
  return (
    <span className="inline-flex items-center justify-center">
      <span className="w-3.5 h-3.5 rounded-full" style={{ background: color }} />
    </span>
  );
}

type Tab = 'trend' | 'stats';

export default function TrendModal({ isOpen, onClose, initialItems = [] }: Props) {
  const [tab, setTab] = useState<Tab>('trend');
  const [items, setItems] = useState<LotteryTerm[]>(initialItems);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/lottery/fengpan');
      const data = await res.json() as { message?: { all?: { keno28?: { data?: LotteryTerm[] } } } };
      const arr = data?.message?.all?.keno28?.data ?? [];
      if (arr.length > 0) setItems(arr);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (isOpen) {
      if (initialItems.length > 0) setItems(initialItems);
      else fetchData();
    }
  }, [isOpen]);

  // ── streak analysis ──────────────────────────────────────────────────────
  const streaks = computeStreaks(items);
  const stats = computeStats(items);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 0.55 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black z-50"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'tween', duration: 0.26 }}
            className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] bg-[#141824] rounded-t-2xl z-50 flex flex-col"
            style={{ height: '91vh' }}
          >
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
              <div className="w-10 h-1 rounded-full bg-white/20" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 flex-shrink-0">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-[#4CA2FF]" />
                <span className="text-white font-semibold text-sm">开奖走势</span>
                {items.length > 0 && (
                  <span className="text-[10px] text-muted-foreground bg-white/5 px-1.5 py-0.5 rounded">
                    近{items.length}期
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={fetchData}
                  disabled={loading}
                  className="text-muted-foreground hover:text-white p-1 transition-colors"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
                <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex mx-4 mt-3 bg-[#1e2538] rounded-xl p-1 gap-1 flex-shrink-0">
              {([
                { id: 'trend' as Tab, label: '走势表', icon: <TrendingUp className="w-3.5 h-3.5" /> },
                { id: 'stats' as Tab, label: '连续统计', icon: <BarChart3 className="w-3.5 h-3.5" /> },
              ] as { id: Tab; label: string; icon: React.ReactNode }[]).map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-all ${
                    tab === t.id ? 'bg-[#3b5de7] text-white shadow' : 'text-muted-foreground hover:text-white'
                  }`}
                >
                  {t.icon}{t.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden mt-3">

              {/* ── TREND TABLE ── */}
              {tab === 'trend' && (
                <div className="h-full overflow-y-auto px-2 pb-6">
                  {items.length === 0 ? (
                    <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">加载中...</div>
                  ) : (
                    <table className="w-full text-xs border-collapse">
                      <thead className="sticky top-0 bg-[#141824] z-10">
                        <tr>
                          <th className="py-2 px-1 text-left text-muted-foreground font-normal">期号</th>
                          <th className="py-2 px-1 text-center text-muted-foreground font-normal" colSpan={5}>号码</th>
                          <th className="py-2 px-0.5 text-center font-bold" style={{ color: '#f44336' }}>大</th>
                          <th className="py-2 px-0.5 text-center font-bold" style={{ color: '#4CA2FF' }}>小</th>
                          <th className="py-2 px-0.5 text-center font-bold" style={{ color: '#c8a520' }}>单</th>
                          <th className="py-2 px-0.5 text-center font-bold" style={{ color: '#10b981' }}>双</th>
                          <th className="py-2 px-0.5 text-center font-bold" style={{ color: '#f44336', fontSize: 9 }}>大单</th>
                          <th className="py-2 px-0.5 text-center font-bold" style={{ color: '#e040fb', fontSize: 9 }}>大双</th>
                          <th className="py-2 px-0.5 text-center font-bold" style={{ color: '#4CA2FF', fontSize: 9 }}>小单</th>
                          <th className="py-2 px-0.5 text-center font-bold" style={{ color: '#10b981', fontSize: 9 }}>小双</th>
                        </tr>
                        <tr>
                          <td colSpan={14} className="pb-1">
                            <div className="h-px bg-white/10" />
                          </td>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((item, idx) => {
                          const isBig = item.r1 === '大';
                          const isOdd = item.r2 === '单';
                          const r3 = item.r3;
                          return (
                            <tr key={item.term} className={idx % 2 === 0 ? 'bg-white/[0.02]' : ''}>
                              <td className="py-1.5 px-1 text-muted-foreground tabular-nums">{item.term}</td>
                              {/* balls */}
                              <td className="py-1.5 px-0.5 text-center"><Ball n={item.sum1} size={18} /></td>
                              <td className="py-1.5 px-0 text-center text-muted-foreground">+</td>
                              <td className="py-1.5 px-0.5 text-center"><Ball n={item.sum2} size={18} /></td>
                              <td className="py-1.5 px-0 text-center text-muted-foreground">+</td>
                              <td className="py-1.5 px-0.5 text-center">
                                <span className="inline-flex items-center gap-0.5">
                                  <Ball n={item.sum3} size={18} />
                                  <span className="text-muted-foreground">=</span>
                                  <Ball n={item.result} size={20} />
                                </span>
                              </td>
                              {/* trend dots */}
                              <td className="py-1.5 px-0.5 text-center"><Dot active={isBig} color="#f44336" /></td>
                              <td className="py-1.5 px-0.5 text-center"><Dot active={!isBig} color="#4CA2FF" /></td>
                              <td className="py-1.5 px-0.5 text-center"><Dot active={isOdd} color="#c8a520" /></td>
                              <td className="py-1.5 px-0.5 text-center"><Dot active={!isOdd} color="#10b981" /></td>
                              <td className="py-1.5 px-0.5 text-center"><Dot active={r3 === '大单'} color="#f44336" /></td>
                              <td className="py-1.5 px-0.5 text-center"><Dot active={r3 === '大双'} color="#e040fb" /></td>
                              <td className="py-1.5 px-0.5 text-center"><Dot active={r3 === '小单'} color="#4CA2FF" /></td>
                              <td className="py-1.5 px-0.5 text-center"><Dot active={r3 === '小双'} color="#10b981" /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* ── STATS TAB ── */}
              {tab === 'stats' && (
                <div className="h-full overflow-y-auto px-4 pb-8 space-y-4">

                  {/* Current streaks */}
                  <div>
                    <div className="text-xs text-muted-foreground mb-2 uppercase tracking-wide">当前连续</div>
                    <div className="grid grid-cols-2 gap-2">
                      {streaks.map(s => (
                        <div key={s.label} className="bg-[#1a2035] border border-white/8 rounded-xl p-3 flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0"
                            style={{ background: s.color + '22', color: s.color }}>
                            {s.label}
                          </div>
                          <div>
                            <div className="text-white font-bold text-lg leading-none">{s.count}<span className="text-xs font-normal text-muted-foreground ml-1">连</span></div>
                            <div className="text-[10px] text-muted-foreground mt-0.5">最近连续{s.count}期{s.label}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Distribution */}
                  <div>
                    <div className="text-xs text-muted-foreground mb-2 uppercase tracking-wide">近{items.length}期分布</div>
                    <div className="bg-[#1a2035] border border-white/8 rounded-xl p-4 space-y-3">
                      {stats.map(s => (
                        <div key={s.label}>
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <ResultBadge label={s.label} />
                              <span className="text-xs text-white">{s.count}次</span>
                            </div>
                            <span className="text-xs font-mono" style={{ color: s.color }}>{s.pct}%</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                            <div className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${s.pct}%`, background: s.color }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Sum chart */}
                  <div>
                    <div className="text-xs text-muted-foreground mb-2 uppercase tracking-wide">和值走势（近{Math.min(items.length, 30)}期）</div>
                    <div className="bg-[#1a2035] border border-white/8 rounded-xl p-4">
                      <SumChart items={items.slice(0, 30).reverse()} />
                    </div>
                  </div>

                  {/* Last 5 periods */}
                  {items.length > 0 && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-2 uppercase tracking-wide">最近5期</div>
                      <div className="space-y-2">
                        {items.slice(0, 5).map(item => (
                          <div key={item.term} className="bg-[#1a2035] border border-white/8 rounded-xl px-3 py-2.5 flex items-center justify-between">
                            <span className="text-xs text-muted-foreground tabular-nums">{item.term}期</span>
                            <div className="flex items-center gap-1">
                              <Ball n={item.sum1} size={20} />
                              <span className="text-muted-foreground text-xs">+</span>
                              <Ball n={item.sum2} size={20} />
                              <span className="text-muted-foreground text-xs">+</span>
                              <Ball n={item.sum3} size={20} />
                              <span className="text-muted-foreground text-xs">=</span>
                              <Ball n={item.result} size={22} />
                            </div>
                            <ResultBadge label={item.r3} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ── Mini SVG line chart for sum values ──────────────────────────────────────
function SumChart({ items }: { items: LotteryTerm[] }) {
  if (items.length < 2) return null;
  const W = 360, H = 80, PAD = 8;
  const vals = items.map(i => i.result);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = Math.max(max - min, 1);
  const step = (W - PAD * 2) / (vals.length - 1);

  const pts = vals.map((v, i) => ({
    x: PAD + i * step,
    y: PAD + ((max - v) / range) * (H - PAD * 2),
    v,
  }));

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = path + ` L${pts[pts.length - 1].x.toFixed(1)},${H} L${pts[0].x.toFixed(1)},${H} Z`;

  // midline (14)
  const midY = PAD + ((max - 14) / range) * (H - PAD * 2);

  return (
    <div className="w-full overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 80 }}>
        {/* mid line at 14 */}
        {midY > PAD && midY < H - PAD && (
          <line x1={PAD} y1={midY} x2={W - PAD} y2={midY} stroke="#ffffff15" strokeWidth="1" strokeDasharray="4,4" />
        )}
        {/* area fill */}
        <path d={area} fill="#3b5de722" />
        {/* line */}
        <path d={path} fill="none" stroke="#4CA2FF" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {/* dots */}
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="2.5"
            fill={ballColor(p.v)} stroke="#141824" strokeWidth="1" />
        ))}
      </svg>
      {/* X labels: show first and last term */}
      <div className="flex justify-between text-[9px] text-muted-foreground mt-0.5 px-1">
        <span>{items[0]?.term}</span>
        <span className="text-muted-foreground/60">— 大小分界线(14)</span>
        <span>{items[items.length - 1]?.term}</span>
      </div>
    </div>
  );
}

// ── Compute current streak per category ─────────────────────────────────────
function computeStreaks(items: LotteryTerm[]) {
  const categories = [
    { label: '大', color: '#f44336', match: (t: LotteryTerm) => t.r1 === '大' },
    { label: '小', color: '#4CA2FF', match: (t: LotteryTerm) => t.r1 === '小' },
    { label: '单', color: '#c8a520', match: (t: LotteryTerm) => t.r2 === '单' },
    { label: '双', color: '#10b981', match: (t: LotteryTerm) => t.r2 === '双' },
  ];
  return categories.map(cat => {
    let count = 0;
    for (const item of items) {
      if (cat.match(item)) count++;
      else break;
    }
    return { label: cat.label, color: cat.color, count };
  });
}

// ── Compute distribution stats ───────────────────────────────────────────────
function computeStats(items: LotteryTerm[]) {
  if (items.length === 0) return [];
  const total = items.length;
  const cats = [
    { label: '大单', color: '#f44336', count: 0 },
    { label: '大双', color: '#e040fb', count: 0 },
    { label: '小单', color: '#4CA2FF', count: 0 },
    { label: '小双', color: '#10b981', count: 0 },
  ];
  for (const item of items) {
    const c = cats.find(c => c.label === item.r3);
    if (c) c.count++;
  }
  return cats.map(c => ({
    ...c,
    pct: Math.round((c.count / total) * 100),
  }));
}
