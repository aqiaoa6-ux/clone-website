import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";
import { api, type TgStatus, type BetRecord, type TgGroup, type AlgoStat } from "../lib/api";
import BottomNav from "../components/BottomNav";

// ─── Types ────────────────────────────────────────────────────────────────────
type TgStep = "phone" | "code" | "password" | "done";

interface DrawState {
  term: number;
  sum1?: number;
  sum2?: number;
  sum3?: number;
  r3?: string;
  nextCloseTime: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const ALGO_LABELS: Record<string, string> = {
  ai_trend:       "AI趋势",
  steady_ai:      "升级版AI",
  adaptive_switch: "自适应切换",
};

const BET_OPT_LABELS: Record<string, string> = {
  big: "大", small: "小", odd: "单", even: "双",
};

const STRATEGY_LABELS: Record<string, string> = {
  normal: "固定", martingale: "马丁", "anti-martingale": "反马丁",
};

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function pnlColor(n: number) { return n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-slate-400"; }

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="bg-[#161929] border border-[#252a3d] rounded-xl p-3 text-center">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className={`text-base font-bold ${valueClass ?? "text-white"}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>}
    </div>
  );
}

function BetTag({ status, won }: { status: string; won?: boolean }) {
  if (status === "sent") return <span className="text-[10px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">待开奖</span>;
  if (status === "won" || won === true) return <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded">中奖</span>;
  if (status === "lost" || won === false) return <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">未中</span>;
  return <span className="text-[10px] bg-slate-500/20 text-slate-400 px-1.5 py-0.5 rounded">失败</span>;
}

function NumBall({ n, sum }: { n?: number; sum?: boolean }) {
  const c = sum
    ? (n !== undefined && n >= 14 ? "bg-red-500" : "bg-blue-500")
    : n !== undefined && n >= 5 ? "bg-orange-500" : "bg-slate-600";
  return (
    <div className={`${c} rounded-full w-7 h-7 flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
      {n ?? "?"}
    </div>
  );
}

// ─── TG Login Flow ────────────────────────────────────────────────────────────

function TgLoginCard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<TgStep>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const send = async (fn: () => Promise<void>) => {
    setError(""); setLoading(true);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setLoading(false); }
  };

  return (
    <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-5 mb-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">📱</span>
        <h3 className="text-white font-semibold">连接 Telegram</h3>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg px-3 py-2 mb-3">{error}</div>}

      {step === "phone" && (
        <div className="space-y-3">
          <input
            type="tel" value={phone} onChange={e => setPhone(e.target.value)}
            placeholder="+8613800001234（含国际区号）"
            className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-4 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
          <button disabled={loading || !phone} onClick={() => send(async () => { await api.tg.sendCode(phone); setStep("code"); })}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold rounded-xl py-2.5 transition">
            {loading ? "发送中..." : "发送验证码"}
          </button>
        </div>
      )}

      {step === "code" && (
        <div className="space-y-3">
          <p className="text-slate-400 text-xs">验证码已发送到 {phone}</p>
          <input
            type="text" value={code} onChange={e => setCode(e.target.value)}
            placeholder="请输入验证码"
            className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-4 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
          <button disabled={loading || !code} onClick={() => send(async () => {
            const r = await api.tg.verifyCode(code);
            if (r.needPassword) setStep("password");
            else { onDone(); }
          })}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold rounded-xl py-2.5 transition">
            {loading ? "验证中..." : "验证"}
          </button>
          <button onClick={() => setStep("phone")} className="w-full text-slate-500 text-xs hover:text-slate-300 transition">重新发送</button>
        </div>
      )}

      {step === "password" && (
        <div className="space-y-3">
          <p className="text-slate-400 text-xs">需要二步验证密码</p>
          <input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="二步验证密码"
            className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-4 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
          <button disabled={loading || !password} onClick={() => send(async () => { await api.tg.verifyPassword(password); onDone(); })}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold rounded-xl py-2.5 transition">
            {loading ? "验证中..." : "确认"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Group Setup ──────────────────────────────────────────────────────────────

function GroupSetupCard({ groups, onDone }: { groups: TgGroup[]; onDone: () => void }) {
  const [link, setLink] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  const filtered = groups.filter(g => g.title.toLowerCase().includes(search.toLowerCase()));

  const selectGroup = async (gid: string) => {
    await api.tg.setGroup(gid);
    onDone();
  };

  const resolveLink = async () => {
    if (!link.trim()) return;
    setError(""); setLoading(true);
    try {
      const r = await api.tg.resolveGroup(link);
      await selectGroup(r.group.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败");
    } finally { setLoading(false); }
  };

  return (
    <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-5 mb-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">💬</span>
        <h3 className="text-white font-semibold">选择投注群组</h3>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg px-3 py-2 mb-3">{error}</div>}

      <div className="flex gap-2 mb-3">
        <input
          type="text" value={link} onChange={e => setLink(e.target.value)}
          placeholder="粘贴群链接 t.me/..."
          className="flex-1 bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500"
        />
        <button onClick={() => void resolveLink()} disabled={loading || !link.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm px-4 rounded-xl transition">
          {loading ? "..." : "搜索"}
        </button>
      </div>

      {groups.length > 0 && (
        <>
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="搜索已加入的群..."
            className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500 mb-2"
          />
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {filtered.map(g => (
              <button key={g.id} onClick={() => void selectGroup(g.id)}
                className="w-full text-left flex items-center gap-3 bg-[#0f1220] hover:bg-[#1a1f35] border border-transparent hover:border-blue-500/30 rounded-xl px-3 py-2 transition">
                <span className="text-slate-400">{g.type === "channel" ? "📢" : "💬"}</span>
                <div>
                  <div className="text-white text-sm">{g.title}</div>
                  {g.membersCount && <div className="text-slate-600 text-[10px]">{g.membersCount} 成员</div>}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Settings Drawer ──────────────────────────────────────────────────────────

function SettingsDrawer({ status, onClose, onSave }: {
  status: TgStatus;
  onClose: () => void;
  onSave: (cfg: Record<string, unknown>) => Promise<void>;
}) {
  const DEFAULT_LEVELS = [100, 200, 400, 800, 1600, 3200];
  const initLevels = status.amountLevels?.length === 6 ? status.amountLevels : DEFAULT_LEVELS;

  const [betAmount, setBetAmount] = useState(String(status.betAmount ?? 100));
  const [strategy, setStrategy] = useState(status.strategy ?? "normal");
  const [multiplier, setMultiplier] = useState(String(status.betMultiplier ?? 2));
  const [stopLoss, setStopLoss] = useState(String(status.stopLoss ?? 5000));
  const [targetProfit, setTargetProfit] = useState(String(status.targetProfit ?? 3000));
  const [maxLoss, setMaxLoss] = useState(String(status.maxConsecutiveLosses ?? 5));
  const [cooldown, setCooldown] = useState(String(status.cooldownSeconds ?? 0));
  const [algos, setAlgos] = useState<string[]>(status.algorithms ?? ["signal_follow"]);
  const [betOpts, setBetOpts] = useState<string[]>(status.betOptions ?? ["big", "small"]);
  const [dualGroupMode, setDualGroupMode] = useState<boolean>(!!(status as unknown as { dualGroupMode?: boolean }).dualGroupMode);
  const [killGroupMode, setKillGroupMode] = useState<boolean>(!!(status as unknown as { killGroupMode?: boolean }).killGroupMode);
  const [kkpay, setKkpay] = useState(status.kkpayUsername ?? "kkpay");
  const [levels, setLevels] = useState<string[]>(initLevels.map(String));
  const [stepBackOnWin, setStepBackOnWin] = useState(status.stepBackOnWin ?? true);
  const [oddsBigSmall, setOddsBigSmall] = useState(String(status.odds ?? 1.98));
  const [oddsBigOdd, setOddsBigOdd] = useState(String(status.oddsBigOdd ?? status.odds ?? 1.98));
  const [oddsBigEven, setOddsBigEven] = useState(String(status.oddsBigEven ?? status.odds ?? 1.98));
  const [oddsSmallOdd, setOddsSmallOdd] = useState(String(status.oddsSmallOdd ?? status.odds ?? 1.98));
  const [oddsSmallEven, setOddsSmallEven] = useState(String(status.oddsSmallEven ?? status.odds ?? 1.98));
  const [chaseNumbers, setChaseNumbers] = useState<Array<{ num: string; amount: string }>>(
    (status.chaseNumbers ?? []).map(c => ({ num: String(c.num), amount: String(c.amount) }))
  );
  const [enableChase, setEnableChase] = useState(status.enableChase ?? false);
  const [showChase, setShowChase] = useState(status.enableChase ?? false);
  const [saving, setSaving] = useState(false);

  const addChase = () => setChaseNumbers(prev => [...prev, { num: "", amount: "" }]);
  const removeChase = (i: number) => setChaseNumbers(prev => prev.filter((_, idx) => idx !== i));
  const setChaseField = (i: number, field: "num" | "amount", val: string) =>
    setChaseNumbers(prev => prev.map((c, idx) => idx === i ? { ...c, [field]: val } : c));

  const toggleAlgo = (a: string) => setAlgos(prev => prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a]);
  const toggleOpt = (o: string) => setBetOpts(prev => prev.includes(o) ? prev.filter(x => x !== o) : [...prev, o]);
  const setLevel = (i: number, v: string) => setLevels(prev => prev.map((x, idx) => idx === i ? v : x));

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        betAmount: Number(betAmount), strategy, betMultiplier: Number(multiplier),
        stopLoss: Number(stopLoss), targetProfit: Number(targetProfit),
        maxConsecutiveLosses: Number(maxLoss), cooldownSeconds: Number(cooldown),
        algorithms: algos, betOptions: betOpts, dualGroupMode, killGroupMode,
        amountLevels: levels.map(Number),
        stepBackOnWin,
        odds: Number(oddsBigSmall),
        oddsBigOdd: Number(oddsBigOdd),
        oddsBigEven: Number(oddsBigEven),
        oddsSmallOdd: Number(oddsSmallOdd),
        oddsSmallEven: Number(oddsSmallEven),
        chaseNumbers: chaseNumbers
          .filter(c => c.num !== "" && c.amount !== "")
          .map(c => ({ num: Number(c.num), amount: Number(c.amount) }))
          .filter(c => c.num >= 0 && c.num <= 27 && c.amount > 0),
        enableChase,
      });
      if (kkpay !== status.kkpayUsername) await api.tg.setKkpay(kkpay);
      onClose();
    } finally { setSaving(false); }
  };

  const sectionCls = "space-y-3 pb-4 mb-4 border-b border-[#252a3d]";
  const labelCls = "block text-xs text-slate-400 mb-1";
  const inputCls = "w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500";
  const tagCls = (active: boolean) => `px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition border ${active ? "bg-blue-600 border-blue-500 text-white" : "bg-[#0f1220] border-[#252a3d] text-slate-400 hover:border-blue-500/50"}`;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <div className="w-80 max-w-[90vw] bg-[#0f1220] border-l border-[#252a3d] overflow-y-auto flex flex-col">
        <div className="flex justify-between items-center px-5 py-4 border-b border-[#252a3d] sticky top-0 bg-[#0f1220]">
          <h3 className="text-white font-semibold">投注设置</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl">×</button>
        </div>

        <div className="p-5 flex-1 space-y-0">
          <div className={sectionCls}>
            <h4 className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-2">玩法策略</h4>
            <div>
              <label className={labelCls}>下注选项</label>
              <div className="flex flex-wrap gap-2">
                {Object.entries(BET_OPT_LABELS).map(([k, v]) => (
                  <span key={k} className={tagCls(betOpts.includes(k))} onClick={() => toggleOpt(k)}>{v}</span>
                ))}
              </div>
              <div className="mt-2 space-y-1.5">
                <p className="text-[10px] text-slate-500">双组模式</p>
                <button
                  type="button"
                  onClick={() => {
                    const next = !dualGroupMode;
                    setDualGroupMode(next);
                    if (next) setBetOpts(["big-odd", "small-even", "small-odd", "big-even"]);
                  }}
                  className={`w-full py-2 rounded-lg text-xs font-medium border transition ${
                    dualGroupMode
                      ? "bg-violet-600 border-violet-500 text-white"
                      : "bg-[#0f1220] border-[#252a3d] text-slate-400 hover:border-violet-500/50"
                  }`}
                >
                  （大单 小双）＋（小单 大双）
                </button>
                {dualGroupMode && (
                  <p className="text-[10px] text-emerald-500">
                    ✓ 已启用 · AI每期从两组中选一组同时发出两注 · 自动避免连续同组
                  </p>
                )}
              </div>
              <div className="mt-2 space-y-1.5">
                <p className="text-[10px] text-slate-500">四组杀组模式</p>
                <button
                  type="button"
                  onClick={() => {
                    const next = !killGroupMode;
                    setKillGroupMode(next);
                    if (next) setDualGroupMode(false);
                  }}
                  className={`w-full py-2 rounded-lg text-xs font-medium border transition ${
                    killGroupMode
                      ? "bg-orange-600 border-orange-500 text-white"
                      : "bg-[#0f1220] border-[#252a3d] text-slate-400 hover:border-orange-500/50"
                  }`}
                >
                  杀一组 · 投三组（大单 大双 小单 小双）
                </button>
                {killGroupMode && (
                  <p className="text-[10px] text-orange-400">
                    ✓ 已启用 · AI分析热度最高的组并杀掉 · 剩余三组同时下注
                  </p>
                )}
              </div>
            </div>
            <div>
              <label className={labelCls}>算法选择</label>
              <div className="flex flex-wrap gap-2">
                {Object.entries(ALGO_LABELS).map(([k, v]) => (
                  <span key={k} className={tagCls(algos.includes(k))} onClick={() => toggleAlgo(k)}>{v}</span>
                ))}
              </div>
            </div>
          </div>

          <div className={sectionCls}>
            <h4 className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-2">金额策略</h4>
            <div>
              <label className={labelCls}>自定义金额（6层，输负加注）</label>
              <div className="grid grid-cols-3 gap-2">
                {levels.map((v, i) => (
                  <div key={i}>
                    <label className="block text-[10px] text-slate-500 mb-0.5">第{i + 1}层</label>
                    <input type="number" value={v} onChange={e => setLevel(i, e.target.value)}
                      className={inputCls} min="1" />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label className={labelCls}>大小玩法赔率（含本金）</label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-slate-500 mb-0.5">大</label>
                  <input type="number" value={oddsBigSmall} onChange={e => setOddsBigSmall(e.target.value)}
                    className={inputCls} min="1.01" step="0.001" />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 mb-0.5">小</label>
                  <input type="number" value={oddsBigSmall} onChange={e => setOddsBigSmall(e.target.value)}
                    className={inputCls} min="1.01" step="0.001" />
                </div>
              </div>
            </div>
            <div>
              <label className={labelCls}>杀组玩法赔率（含本金）</label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  ["大单", oddsBigOdd, setOddsBigOdd],
                  ["大双", oddsBigEven, setOddsBigEven],
                  ["小单", oddsSmallOdd, setOddsSmallOdd],
                  ["小双", oddsSmallEven, setOddsSmallEven],
                ] as [string, string, (v: string) => void][]).map(([label, val, setter]) => (
                  <div key={label}>
                    <label className="block text-[10px] text-slate-500 mb-0.5">{label}</label>
                    <input type="number" value={val} onChange={e => setter(e.target.value)}
                      className={inputCls} min="1.01" step="0.001" />
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">中后回首注</span>
              <button onClick={() => setStepBackOnWin(v => !v)}
                className={`w-11 h-6 rounded-full transition-colors ${stepBackOnWin ? "bg-blue-600" : "bg-[#252a3d]"} relative`}>
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${stepBackOnWin ? "left-5" : "left-0.5"}`} />
              </button>
            </div>
            <div>
              <label className={labelCls}>资金策略</label>
              <div className="flex gap-2">
                {Object.entries(STRATEGY_LABELS).map(([k, v]) => (
                  <span key={k} className={`flex-1 text-center ${tagCls(strategy === k)}`} onClick={() => setStrategy(k)}>{v}</span>
                ))}
              </div>
            </div>
            {strategy !== "normal" && (
              <div>
                <label className={labelCls}>倍数</label>
                <input type="number" value={multiplier} onChange={e => setMultiplier(e.target.value)} className={inputCls} min="1.1" step="0.1" />
              </div>
            )}
          </div>

          <div className={sectionCls}>
            <h4 className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-2">风控设置</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>止损金额</label>
                <input type="number" value={stopLoss} onChange={e => setStopLoss(e.target.value)} className={inputCls} min="0" />
              </div>
              <div>
                <label className={labelCls}>止盈金额</label>
                <input type="number" value={targetProfit} onChange={e => setTargetProfit(e.target.value)} className={inputCls} min="0" />
              </div>
              <div>
                <label className={labelCls}>最大连亏</label>
                <input type="number" value={maxLoss} onChange={e => setMaxLoss(e.target.value)} className={inputCls} min="0" />
              </div>
              <div>
                <label className={labelCls}>冷却秒数</label>
                <input type="number" value={cooldown} onChange={e => setCooldown(e.target.value)} className={inputCls} min="0" />
              </div>
            </div>
          </div>

          {/* ── 自动追号（折叠区） ── */}
          <div className="pb-4 mb-4 border-b border-[#252a3d]">
            {/* 标题行：点击展开/折叠 */}
            <button
              type="button"
              onClick={() => setShowChase(v => !v)}
              className="w-full flex items-center justify-between py-2 group"
            >
              <div className="flex items-center gap-2">
                <span className="text-base leading-none">🎯</span>
                <span className="text-xs font-medium text-slate-400 group-hover:text-white transition">自动追号</span>
                {enableChase && chaseNumbers.filter(c => c.num !== "" && c.amount !== "").length > 0 && (
                  <span className="text-[10px] bg-amber-500/20 text-amber-400 rounded px-1.5 py-0.5">
                    {chaseNumbers.filter(c => c.num !== "" && c.amount !== "").length} 个 · {chaseNumbers.filter(c => c.amount !== "").reduce((s, c) => s + (Number(c.amount) || 0), 0)} 元/期
                  </span>
                )}
              </div>
              <span className={`text-slate-500 text-xs transition-transform duration-200 ${showChase ? "rotate-180" : ""}`}>▼</span>
            </button>

            {/* 展开内容 */}
            {showChase && (
              <div className={`mt-2 rounded-2xl border-2 transition-colors pb-3 ${enableChase ? "border-amber-500/60 bg-amber-500/5" : "border-[#252a3d] bg-transparent"}`}>
                {/* 开关行 */}
                <div className={`flex items-center justify-between px-4 py-2.5 rounded-t-2xl ${enableChase ? "bg-amber-500/10" : "bg-[#131728]/60"}`}>
                  <p className={`text-xs font-semibold ${enableChase ? "text-amber-300" : "text-slate-400"}`}>
                    随主注每期同步下注 · 号码 0–27
                  </p>
                  <button
                    onClick={() => setEnableChase(v => !v)}
                    className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${enableChase ? "bg-amber-500" : "bg-[#252a3d]"}`}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${enableChase ? "left-5.5" : "left-0.5"}`} />
                  </button>
                </div>

                {/* 号码列表 */}
                <div className="px-4 pt-3 space-y-2">
                  {chaseNumbers.length === 0 && (
                    <p className="text-[11px] text-slate-600 text-center py-1">暂无追号，点击下方添加</p>
                  )}
                  {chaseNumbers.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="flex-[1]">
                        <input
                          type="number" placeholder="号码 0-27"
                          value={c.num}
                          onChange={e => setChaseField(i, "num", e.target.value)}
                          min="0" max="27"
                          className={`w-full rounded-xl px-3 py-2 text-white text-sm focus:outline-none border ${enableChase ? "bg-[#1a1610] border-amber-500/30 focus:border-amber-400" : "bg-[#0f1220] border-[#252a3d] focus:border-blue-500"}`}
                        />
                      </div>
                      <span className="text-slate-600 text-xs flex-shrink-0">×</span>
                      <div className="flex-[1]">
                        <input
                          type="number" placeholder="金额"
                          value={c.amount}
                          onChange={e => setChaseField(i, "amount", e.target.value)}
                          min="1"
                          className={`w-full rounded-xl px-3 py-2 text-white text-sm focus:outline-none border ${enableChase ? "bg-[#1a1610] border-amber-500/30 focus:border-amber-400" : "bg-[#0f1220] border-[#252a3d] focus:border-blue-500"}`}
                        />
                      </div>
                      <button
                        onClick={() => removeChase(i)}
                        className="text-slate-600 hover:text-rose-400 transition text-xl leading-none w-6 text-center flex-shrink-0"
                      >×</button>
                    </div>
                  ))}

                  <button
                    onClick={addChase}
                    className={`w-full border border-dashed rounded-xl py-2 text-xs transition ${enableChase ? "border-amber-500/40 text-amber-500/70 hover:border-amber-400 hover:text-amber-400" : "border-[#252a3d] text-slate-600 hover:border-blue-500/50 hover:text-blue-400"}`}
                  >
                    + 添加追号
                  </button>

                  {chaseNumbers.filter(c => c.num !== "" && c.amount !== "").length > 0 && (
                    <div className={`flex items-center justify-between text-[11px] rounded-lg px-3 py-1.5 ${enableChase ? "bg-amber-500/10 text-amber-400" : "bg-[#131728] text-slate-500"}`}>
                      <span>{chaseNumbers.filter(c => c.num !== "" && c.amount !== "").length} 个号码</span>
                      <span>每期追注 {chaseNumbers.filter(c => c.amount !== "").reduce((s, c) => s + (Number(c.amount) || 0), 0)} 元</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="pb-4">
            <h4 className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-3">KKPay 钱包</h4>
            <div>
              <label className={labelCls}>KKPay 用户名（@username）</label>
              <input type="text" value={kkpay} onChange={e => setKkpay(e.target.value)} className={inputCls} placeholder="kkpay" />
            </div>
          </div>
        </div>

        <div className="p-5 pb-20 border-t border-[#252a3d] sticky bottom-0 bg-[#0f1220]">
          <button onClick={() => void save()} disabled={saving}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold rounded-xl py-3 transition">
            {saving ? "保存中..." : "保存设置"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const { user, card, countdown: cardCountdown, logout } = useAuth();
  const [, setLocation] = useLocation();

  const [status, setStatus] = useState<TgStatus | null>(null);
  const [bets, setBets] = useState<BetRecord[]>([]);
  const [draw, setDraw] = useState<DrawState | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [nextBetAt, setNextBetAt] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showGroupSetup, setShowGroupSetup] = useState(false);
  const [groups, setGroups] = useState<TgGroup[]>([]);
  const [tgStep, setTgStep] = useState<"checking" | "login" | "group" | "ready">("checking");
  const [toggleLoading, setToggleLoading] = useState(false);
  const [clearLoading, setClearLoading] = useState(false);
  const [sseAlert, setSseAlert] = useState<string | null>(null);
  const [algoStats, setAlgoStats] = useState<AlgoStat[]>([]);

  const nextCloseRef = useRef<number>(0);
  const sseRef = useRef<EventSource | null>(null);

  // ─── Fetch lottery draw data ─────────────────────────────────────────────

  const fetchDraw = useCallback(async () => {
    try {
      const data = await api.lottery.fengpan();
      const items = data?.message?.all?.keno28?.data ?? [];
      if (!items.length) return;
      const latest = items[0]!;
      const closeMs = latest.closeTime ?? 0;
      const openMs = latest.openTime ?? 0;
      const now = Date.now();
      const cycleMs = closeMs > openMs && closeMs - openMs < 600000 ? closeMs - openMs : 210000;
      const targetClose = closeMs > now ? closeMs : closeMs + cycleMs;
      nextCloseRef.current = targetClose > now ? targetClose : now + cycleMs;
      setDraw({ term: latest.term + (closeMs < now ? 1 : 0), sum1: latest.sum1, sum2: latest.sum2, sum3: latest.sum3, r3: latest.r3, nextCloseTime: nextCloseRef.current });
    } catch { /* ignore */ }
  }, []);

  // ─── Fetch status ────────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try {
      const s = await api.tg.status();
      setStatus(s);
      if (!s.connected) { setTgStep("login"); return; }
      if (!s.watchGroupId) {
        const { groups: g } = await api.tg.groups();
        setGroups(g);
        setTgStep("group");
        return;
      }
      setTgStep("ready");
    } catch { setTgStep("login"); }
  }, []);

  const fetchBets = useCallback(async () => {
    try {
      const { bets: b } = await api.tg.bets();
      setBets(b);
    } catch { /* ignore */ }
  }, []);

  const fetchAlgoLeaderboard = useCallback(async () => {
    try {
      const { stats } = await api.tg.algoLeaderboard();
      setAlgoStats(stats);
    } catch { /* ignore */ }
  }, []);

  // ─── SSE stream ──────────────────────────────────────────────────────────

  useEffect(() => {
    const es = new EventSource("/api/tg/events", { withCredentials: true });
    sseRef.current = es;

    es.onmessage = (e) => {
      if (!e.data) return;
      try {
        const ev = JSON.parse(e.data as string) as Record<string, unknown>;
        if (ev.type === "draw:new") {
          const closeMs = ev.closeTime as number ?? 0;
          const openMs = ev.openTime as number ?? 0;
          const nowT = Date.now();
          const cycleMs = closeMs > openMs && closeMs - openMs < 600000 ? closeMs - openMs : 210000;
          const targetClose = closeMs > nowT ? closeMs : closeMs + cycleMs;
          nextCloseRef.current = targetClose > nowT ? targetClose : nowT + cycleMs;
          if (ev.nextCloseTime as number) nextCloseRef.current = ev.nextCloseTime as number;
          const term = ev.term as number;
          setDraw({ term: term + (closeMs < nowT ? 1 : 0), sum1: ev.sum1 as number, sum2: ev.sum2 as number, sum3: ev.sum3 as number, r3: ev.r3 as string, nextCloseTime: nextCloseRef.current });
        }
        if (ev.type === "timer:scheduled") {
          if (ev.fireAt) setNextBetAt(ev.fireAt as number);
        }
        if (ev.type === "bet:new" || ev.type === "bet:result") {
          void fetchBets();
          if (ev.type === "bet:result") {
            void fetchStatus();
            void fetchAlgoLeaderboard();
          }
        }
        if (ev.type === "balance:update") {
          setStatus(prev => prev ? { ...prev, balance: ev.balance as number, balanceSource: ev.balanceSource as string, balanceUpdatedAt: ev.balanceUpdatedAt as number } : prev);
        }
        if (ev.type === "chase:won_stop") {
          // 追号中奖，后端已自动关闭 enableChase，刷新 status 以同步配置
          void fetchStatus();
        }
        if (ev.type === "bet:alert") {
          const msg = ev.msg as string;
          setSseAlert(msg);
          // Auto-stop detected on backend; sync status so the toggle reflects the new state
          void fetchStatus();
        }
      } catch { /* ignore */ }
    };

    return () => { es.close(); sseRef.current = null; };
  }, [fetchBets, fetchStatus, fetchAlgoLeaderboard]);

  // ─── Init & polling ──────────────────────────────────────────────────────

  useEffect(() => {
    void fetchStatus();
    void fetchBets();
    void fetchDraw();
    void fetchAlgoLeaderboard();
    const statusInterval = setInterval(() => void fetchStatus(), 10_000);
    const drawInterval = setInterval(() => void fetchDraw(), 60_000);
    const tickInterval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => { clearInterval(statusInterval); clearInterval(drawInterval); clearInterval(tickInterval); };
  }, [fetchStatus, fetchBets, fetchDraw, fetchAlgoLeaderboard]);

  // ─── Derived state ───────────────────────────────────────────────────────

  const countdown = draw ? Math.max(0, Math.floor((draw.nextCloseTime - nowMs) / 1000)) : 0;
  const nextBetIn = nextBetAt && nextBetAt > nowMs ? Math.ceil((nextBetAt - nowMs) / 1000) : null;
  const cardExpiry = card?.expiresAt ? new Date(card.expiresAt) : null;
  const cardDaysLeft = cardExpiry ? Math.ceil((cardExpiry.getTime() - Date.now()) / 86400000) : 0;

  const mainBets = bets.filter(b => !b.isChase);
  const settled = mainBets.filter(b => b.won !== undefined);
  const wins = settled.filter(b => b.won === true).length;
  const winRate = settled.length > 0 ? ((wins / settled.length) * 100).toFixed(1) : "0.0";
  let maxStreak = 0, curStreak = 0;
  for (const b of [...mainBets].reverse()) {
    if (b.won === true) { curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; }
    else if (b.won === false) curStreak = 0;
  }

  // ─── Actions ─────────────────────────────────────────────────────────────

  const toggleAutoBet = async () => {
    if (!status) return;
    setToggleLoading(true);
    try {
      const newState = !status.autoBet;
      await api.tg.config({ autoBet: newState });
      setStatus(prev => prev ? { ...prev, autoBet: newState } : prev);
      if (!newState) setNextBetAt(null);
    } finally { setToggleLoading(false); }
  };

  const saveCfg = async (cfg: Record<string, unknown>) => {
    await api.tg.config(cfg);
    await fetchStatus();
  };

  const clearBets = async () => {
    setClearLoading(true);
    try { await api.tg.clearBets(); setBets([]); }
    finally { setClearLoading(false); }
  };

  const handleDisconnect = async () => {
    await api.tg.disconnect();
    setTgStep("login");
    setStatus(null);
    setNextBetAt(null);
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0b0e1a] text-white">
      {/* SSE Alert Banner */}
      {sseAlert && (
        <div className="sticky top-0 z-50 bg-red-900/90 border-b border-red-700 px-4 py-3 flex items-start gap-3 backdrop-blur">
          <span className="text-red-300 text-lg leading-none mt-0.5">⚠</span>
          <span className="flex-1 text-sm text-red-100 leading-snug">{sseAlert}</span>
          <button onClick={() => setSseAlert(null)} className="text-red-300 hover:text-white text-lg leading-none flex-shrink-0">×</button>
        </div>
      )}
      {/* Header */}
      <div className="sticky top-0 z-40 bg-[#0b0e1a]/95 border-b border-[#1e2235] backdrop-blur">
        <div className="max-w-lg mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <span className="text-xl">🎰</span>
            <span className="font-bold text-white">彩票机器人</span>
            {card?.active && cardCountdown && (
              <span className={`text-[10px] border px-1.5 py-0.5 rounded font-mono tabular-nums ${
                !cardCountdown.includes("天") && parseInt(cardCountdown.split(":")[0] ?? "99") < 1
                  ? "bg-red-500/20 text-red-400 border-red-500/30 animate-pulse"
                  : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
              }`}>
                {card.type === "daily" ? "天卡" : card.type === "weekly" ? "周卡" : "月卡"} {cardCountdown}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 bg-slate-700/60 border border-slate-600/50 rounded-full px-2.5 py-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
              <span className="text-slate-200 text-xs font-medium max-w-[80px] truncate">{user?.username}</span>
            </span>
            <button
              onClick={() => void logout()}
              className="text-xs px-2.5 py-0.5 rounded-full border border-red-500/40 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition"
            >
              退出
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-4 space-y-3 pb-24">

        {/* TG Login */}
        {tgStep === "login" && <TgLoginCard onDone={() => void fetchStatus()} />}

        {/* Group Setup */}
        {tgStep === "group" && (
          <GroupSetupCard groups={groups} onDone={() => void fetchStatus()} />
        )}

        {/* Main content when ready */}
        {tgStep === "ready" && status && (
          <>
            {/* Balance */}
            <div className="bg-gradient-to-br from-[#161929] to-[#0f1428] border border-[#252a3d] rounded-2xl p-5">
              <div className="flex justify-between items-start mb-1">
                <span className="text-slate-400 text-xs">当前余额</span>
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${status.kkpayEntityId ? "bg-emerald-400" : "bg-slate-500"}`} />
                  <span className="text-[10px] text-slate-500">
                    {status.balanceSource === "kkpay" ? `@kkpay ${status.balanceUpdatedAt ? fmtDate(status.balanceUpdatedAt) : ""}` : "手动"}
                  </span>
                </div>
              </div>
              <div className="text-3xl font-bold text-emerald-400 mb-3">
                {(status.balance ?? 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div className="flex gap-4 text-sm">
                <div>
                  <span className="text-slate-500 text-xs">今日</span>
                  <span className={`ml-1 font-semibold ${pnlColor(status.todayPnl ?? 0)}`}>
                    {(status.todayPnl ?? 0) >= 0 ? "+" : ""}{fmtNum(status.todayPnl ?? 0)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 text-xs">本次</span>
                  <span className={`ml-1 font-semibold ${pnlColor(status.sessionPnl ?? 0)}`}>
                    {(status.sessionPnl ?? 0) >= 0 ? "+" : ""}{fmtNum(status.sessionPnl ?? 0)}
                  </span>
                </div>
              </div>
            </div>

            {/* Period & Countdown */}
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-5">
              <div className="flex justify-between items-center mb-3">
                <div>
                  <span className="text-slate-400 text-xs">当前期号</span>
                  <div className="text-white font-bold text-lg">{draw?.term ?? "---"}期</div>
                </div>
                {draw?.sum1 !== undefined && (
                  <div className="flex items-center gap-1.5">
                    <NumBall n={draw.sum1} />
                    <span className="text-slate-500">+</span>
                    <NumBall n={draw.sum2} />
                    <span className="text-slate-500">+</span>
                    <NumBall n={draw.sum3} />
                    <span className="text-slate-500">=</span>
                    <NumBall n={(draw.sum1 ?? 0) + (draw.sum2 ?? 0) + (draw.sum3 ?? 0)} sum />
                    <span className="text-[10px] text-slate-400 ml-1">{draw.r3}</span>
                  </div>
                )}
              </div>

              {/* Countdown display */}
              <div className="text-center py-2">
                <div className={`text-5xl font-bold font-mono tracking-tight transition-colors ${
                  countdown <= 80 && countdown > 0 ? "text-yellow-400" : "text-white"
                }`}>
                  {String(Math.floor(countdown / 60)).padStart(2, "0")}:{String(countdown % 60).padStart(2, "0")}
                </div>
                <div className="text-slate-500 text-xs mt-1">距封盘倒计时</div>
              </div>

              {/* Progress bar showing 80s bet zone */}
              {draw && (() => {
                const cycleSec = 210;
                const pct = Math.min(100, Math.max(0, (countdown / cycleSec) * 100));
                const betZonePct = Math.min(100, (80 / cycleSec) * 100);
                return (
                  <div className="mt-1 mb-2">
                    <div className="relative h-2 bg-[#0f1220] rounded-full overflow-hidden">
                      {/* bet zone highlight (last 80s) */}
                      <div className="absolute right-0 top-0 h-full rounded-full bg-yellow-500/20" style={{ width: `${betZonePct}%` }} />
                      {/* time remaining bar */}
                      <div
                        className={`absolute left-0 top-0 h-full rounded-full transition-all duration-1000 ${
                          countdown <= 80 ? "bg-yellow-400" : "bg-blue-500"
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
                      <span>开奖</span>
                      <span className="text-yellow-600/70">←投注区间 01:20→</span>
                      <span>封盘</span>
                    </div>
                  </div>
                );
              })()}

              {/* Bet window active */}
              {status.autoBet && countdown > 0 && countdown <= 80 && (
                <div className="mt-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-2.5 text-center">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse mr-2 align-middle" />
                  <span className="text-yellow-400 text-sm font-semibold">投注窗口开启中</span>
                  <span className="text-yellow-400/50 text-xs ml-2">剩余 {countdown}s</span>
                </div>
              )}

              {/* Next bet countdown (outside bet window) */}
              {nextBetIn !== null && status.autoBet && countdown > 80 && (
                <div className="mt-2 bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-2.5 text-center">
                  <span className="text-blue-400 text-sm">
                    距投注还有 <span className="font-bold">{nextBetIn}s</span>
                    <span className="text-blue-300/50 text-xs ml-1">（封盘前 01:20 下注）</span>
                  </span>
                </div>
              )}

              {status.riskBlocked && (
                <div className="mt-2 bg-orange-500/10 border border-orange-500/20 rounded-xl px-4 py-2.5 text-center">
                  <span className="text-orange-400 text-xs">⚠️ {status.riskReason}</span>
                </div>
              )}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-4 gap-2">
              <StatCard label="总投注" value={String(mainBets.length)} />
              <StatCard label="胜率" value={`${winRate}%`} valueClass={parseFloat(winRate) >= 50 ? "text-emerald-400" : "text-red-400"} />
              <StatCard label="最大连中" value={String(maxStreak)} valueClass="text-emerald-400" />
              <StatCard label="连亏" value={status.consecutiveLosses ? `${status.consecutiveLosses}局` : "-"}
                valueClass={(status.consecutiveLosses ?? 0) >= 3 ? "text-red-400" : "text-white"} />
            </div>

            {/* Auto Bet Controls */}
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-5">
              <div className="flex justify-between items-center mb-4">
                <div>
                  <div className="text-white font-semibold">自动投注</div>
                  <div className="text-slate-500 text-xs mt-0.5">
                    {status.autoBet ? (() => {
                      const patternLabel = status.currentPattern === "streak" ? "📈长龙局" : status.currentPattern === "oscillating" ? "🔄震荡局" : null;
                      const algoLabel = ALGO_LABELS[status.lastAlgoUsed ?? status.algorithms?.[0] ?? ""] ?? "未知算法";
                      const adaptiveLabel = status.algorithms?.includes("adaptive_switch")
                        ? (status.adaptiveSwitchKillMode ? " · 🎯杀组中" : " · 大小中")
                        : "";
                      return `运行中 · ${patternLabel ? patternLabel + " · " : ""}${algoLabel}${adaptiveLabel}`;
                    })() : "已停止"}
                  </div>
                </div>
                <button
                  onClick={() => void toggleAutoBet()}
                  disabled={toggleLoading}
                  className={`relative w-14 h-7 rounded-full transition-colors ${status.autoBet ? "bg-blue-600" : "bg-[#252a3d]"} ${toggleLoading ? "opacity-50" : ""}`}
                >
                  <div className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow transition-all ${status.autoBet ? "left-8" : "left-1"}`} />
                </button>
              </div>


              <div className="mt-3 flex gap-2">
                <button onClick={() => setShowSettings(true)}
                  className="flex-1 bg-[#252a3d] hover:bg-[#30375a] text-slate-300 text-sm py-2 rounded-xl transition">
                  ⚙️ 详细设置
                </button>
                <button onClick={() => { setShowGroupSetup(true); void api.tg.groups().then(r => setGroups(r.groups)); }}
                  className="flex-1 bg-[#252a3d] hover:bg-[#30375a] text-slate-300 text-sm py-2 rounded-xl transition">
                  💬 {status.watchGroupTitle ? status.watchGroupTitle.slice(0, 8) + "..." : "换群"}
                </button>
              </div>
            </div>

            {/* Algo Leaderboard */}
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-[#252a3d] flex items-center justify-between">
                <h3 className="text-white font-semibold text-sm">🏆 算法排行榜</h3>
                <span className="text-slate-600 text-[10px]">基于近期走势回测</span>
              </div>
              {algoStats.length === 0 ? (
                <div className="text-center text-slate-600 text-xs py-6">请先在设置中选择算法</div>
              ) : (
                <div className="divide-y divide-[#1e2235]">
                  {algoStats.map((s, i) => {
                    const ALGO_LABELS: Record<string, string> = {
                      ai_trend: "AI趋势", steady_ai: "升级版AI", adaptive_switch: "自适应切换",
                      signal_follow: "跟信号", signal_reverse: "反信号", streak_follow: "跟龙",
                      cold_pick: "冷号", random: "随机", dragon_ride: "顺龙",
                      dragon_break: "破龙", momentum: "动量", anti_streak: "反连",
                    };
                    const name = ALGO_LABELS[s.algoId] ?? s.algoId;
                    // 主要指标：走势回测胜率；次要：实战统计
                    const simRate = s.simWinRate ? parseFloat(s.simWinRate) : null;
                    const rateColor = simRate === null ? "text-slate-500"
                      : simRate >= 55 ? "text-emerald-400"
                      : simRate >= 45 ? "text-yellow-400"
                      : "text-red-400";
                    return (
                      <div key={s.algoId} className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <span className="text-slate-500 text-xs w-4 flex-shrink-0">#{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-white text-xs font-medium">{name}</span>
                              {s.canSimulate ? (
                                <span className="text-slate-600 text-[10px]">回测{s.simTotal}期</span>
                              ) : (
                                <span className="text-slate-600 text-[10px]">信号算法</span>
                              )}
                            </div>
                            {/* 走势回测 */}
                            {s.canSimulate && s.simTotal > 0 && (
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-slate-500 text-[9px]">走势</span>
                                <span className="text-emerald-400 text-[10px]">中{s.simWins}</span>
                                <span className="text-red-400 text-[10px]">未{s.simLosses}</span>
                              </div>
                            )}
                            {/* 实战统计 */}
                            {s.total > 0 && (
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-slate-500 text-[9px]">实战</span>
                                <span className="text-emerald-400 text-[10px]">中{s.wins}</span>
                                <span className="text-red-400 text-[10px]">未{s.losses}</span>
                                <span className={`text-[9px] ${s.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                  {s.pnl >= 0 ? "+" : ""}{s.pnl.toLocaleString()}
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="text-right flex-shrink-0">
                            {s.canSimulate && s.simWinRate ? (
                              <div className={`text-sm font-bold ${rateColor}`}>{s.simWinRate}%</div>
                            ) : (
                              <div className="text-slate-600 text-sm">—</div>
                            )}
                            {s.total > 0 && s.winRate && (
                              <div className="text-slate-500 text-[10px] mt-0.5">实{s.winRate}%</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Bet History */}
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl overflow-hidden">
              <div className="flex justify-between items-center px-5 py-3 border-b border-[#252a3d]">
                <h3 className="text-white font-semibold text-sm">📋 投注记录</h3>
                <div className="flex gap-2 items-center">
                  <span className="text-slate-500 text-xs">{bets.length} 条</span>
                  <button onClick={() => void clearBets()} disabled={clearLoading || bets.length === 0}
                    className="text-xs text-red-400 hover:text-red-300 disabled:opacity-30 transition px-2 py-0.5 rounded border border-red-500/20 hover:border-red-500/40">
                    清空
                  </button>
                </div>
              </div>

              {bets.length === 0 ? (
                <div className="text-center text-slate-600 text-sm py-10">暂无投注记录</div>
              ) : (
                <div className="divide-y divide-[#1e2235]">
                  {bets.slice(0, 30).map(b => (
                    <div key={b.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-white text-sm font-semibold">{b.betContent}</span>
                          <span className="text-slate-500 text-xs">{b.amount.toLocaleString()}</span>
                          {b.period && <span className="text-slate-600 text-[10px]">{b.period}期</span>}
                        </div>
                        <div className="text-slate-600 text-[10px] mt-0.5">
                          {fmtDate(b.timestamp)} · {b.lotteryResult ?? b.messageText.slice(0, 20)}
                        </div>
                        {b.status === "failed" && b.failReason && (
                          <div className="text-red-400 text-[10px] mt-0.5 font-mono">{b.failReason}</div>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <BetTag status={b.status} won={b.won} />
                        {b.pnl !== undefined && (
                          <div className={`text-xs font-semibold mt-1 ${pnlColor(b.pnl)}`}>
                            {b.pnl >= 0 ? "+" : ""}{b.pnl.toLocaleString()}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* TG Info */}
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
              <div className="flex justify-between items-center">
                <div className="text-xs text-slate-400">
                  <span className="text-emerald-400 mr-1.5">●</span>
                  已连接：{status.me?.firstName ?? ""} {status.me?.username ? `@${status.me.username}` : ""}
                </div>
                <button onClick={() => void handleDisconnect()} className="text-xs text-red-400 hover:text-red-300 transition">
                  断开连接
                </button>
              </div>
            </div>
          </>
        )}

        {/* Loading state */}
        {tgStep === "checking" && (
          <div className="text-center text-slate-500 py-20">加载中...</div>
        )}
      </div>

      {/* Settings Drawer */}
      {showSettings && status && (
        <SettingsDrawer status={status} onClose={() => setShowSettings(false)} onSave={saveCfg} />
      )}

      {/* Group Switcher */}
      {showGroupSetup && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="flex-1 bg-black/60 absolute inset-0" onClick={() => setShowGroupSetup(false)} />
          <div className="relative w-full bg-[#0f1220] border-t border-[#252a3d] rounded-t-2xl p-4 pb-8 max-h-[80vh] overflow-y-auto z-50">
            <GroupSetupCard groups={groups} onDone={() => { setShowGroupSetup(false); void fetchStatus(); }} />
          </div>
        </div>
      )}
      <BottomNav />
    </div>
  );
}
