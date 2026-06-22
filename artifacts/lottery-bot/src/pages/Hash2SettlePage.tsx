import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import BottomNav from "../components/BottomNav";
import { useAuth } from "../context/AuthContext";
import { api, type Hash2Config, type Hash2Plan } from "../lib/api";

const HASH2_BET_OPTIONS: Array<{ key: string; label: string; group: "玩法1" | "玩法2" }> = [
  { key: "big", label: "大", group: "玩法1" },
  { key: "small", label: "小", group: "玩法1" },
  { key: "odd", label: "单", group: "玩法1" },
  { key: "even", label: "双", group: "玩法1" },
  { key: "big-odd", label: "大单", group: "玩法1" },
  { key: "big-even", label: "大双", group: "玩法1" },
  { key: "small-odd", label: "小单", group: "玩法1" },
  { key: "small-even", label: "小双", group: "玩法1" },
  { key: "extreme-big", label: "极大", group: "玩法2" },
  { key: "extreme-small", label: "极小", group: "玩法2" },
  { key: "leopard", label: "豹子", group: "玩法2" },
  { key: "pair", label: "对子", group: "玩法2" },
  { key: "straight", label: "顺子", group: "玩法2" },
  ...Array.from({ length: 28 }, (_, i) => ({ key: `num:${i}`, label: String(i), group: "玩法2" as const })),
];

function NumericDraftInput({
  value,
  min = 0,
  className,
  onCommit,
}: {
  value: number;
  min?: number;
  className?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const raw = draft.trim();
    if (raw === "") {
      onCommit(min);
      return;
    }
    let next = Number(raw);
    if (!Number.isFinite(next)) next = min;
    onCommit(Math.max(min, next));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      className={className}
    />
  );
}

function makeFallbackPlan(index: number): Hash2Plan {
  return {
    id: `plan-${index + 1}`,
    name: `方案${index + 1}`,
    enabled: false,
    bets: [],
    baseAmount: 0,
    handCount: 60,
    amountLevels: Array.from({ length: 60 }, () => 0),
    stopLoss: 0,
    targetProfit: 0,
    zeroAmountRuns: true,
    format: "target_first",
    webAlertEnabled: true,
    voiceAlertEnabled: true,
    basicOdds: {
      big: 2,
      small: 2,
      odd: 2,
      even: 2,
    },
    comboOdds: {
      "big-odd": 4.2,
      "big-even": 4.2,
      "small-odd": 4.2,
      "small-even": 4.2,
    },
    numberOdds: Object.fromEntries(Array.from({ length: 28 }, (_, i) => [String(i), 0])),
    specialOdds: {
      "extreme-big": 15,
      "extreme-small": 15,
      leopard: 88,
      pair: 3.4,
      straight: 18,
    },
  };
}

function makeFallbackConfig(): Hash2Config {
  return {
    plans: Array.from({ length: 5 }, (_, i) => makeFallbackPlan(i)),
    updatedAt: Date.now(),
  };
}

function getBetLabel(key: string): string {
  return HASH2_BET_OPTIONS.find(item => item.key === key)?.label ?? key;
}

function getBetOdds(plan: Hash2Plan, key: string): number {
  if (key === "big" || key === "small" || key === "odd" || key === "even") {
    return plan.basicOdds[key] ?? 0;
  }
  if (key === "big-odd" || key === "big-even" || key === "small-odd" || key === "small-even") {
    return plan.comboOdds[key] ?? 0;
  }
  if (key === "extreme-big" || key === "extreme-small" || key === "leopard" || key === "pair" || key === "straight") {
    return plan.specialOdds[key] ?? 0;
  }
  if (key.startsWith("num:")) {
    return plan.numberOdds[key.slice(4)] ?? 0;
  }
  return 0;
}

function formatAmount(value: number): string {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

export default function Hash2SettlePage() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [config, setConfig] = useState<Hash2Config>(makeFallbackConfig());
  const [loading, setLoading] = useState(true);
  const [activePlan, setActivePlan] = useState(0);
  const [selectedBet, setSelectedBet] = useState("big");
  const [initialBalance, setInitialBalance] = useState(100);
  const [stake, setStake] = useState(5);
  const [actualResult, setActualResult] = useState<"win" | "lose">("win");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const cfg = await api.hash2.config();
        if (!mounted) return;
        setConfig(cfg.plans?.length ? cfg : makeFallbackConfig());
      } catch (e) {
        if (!mounted) return;
        setConfig(makeFallbackConfig());
        setErrorMessage(e instanceof Error ? e.message : "读取加拿大新版配置失败");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const currentPlan = config.plans[activePlan] ?? makeFallbackPlan(activePlan);
  const enabledBetOptions = useMemo(() => {
    return currentPlan.bets
      .map(key => HASH2_BET_OPTIONS.find(item => item.key === key))
      .filter((item): item is (typeof HASH2_BET_OPTIONS)[number] => Boolean(item));
  }, [currentPlan.bets]);

  useEffect(() => {
    if (enabledBetOptions.some(item => item.key === selectedBet)) return;
    if (enabledBetOptions[0]?.key) {
      setSelectedBet(enabledBetOptions[0].key);
      return;
    }
    if (!HASH2_BET_OPTIONS.some(item => item.key === selectedBet)) {
      setSelectedBet("big");
    }
  }, [enabledBetOptions, selectedBet]);

  const currentOdds = getBetOdds(currentPlan, selectedBet);
  const betLabel = getBetLabel(selectedBet);
  const payout = stake * currentOdds;
  const winNet = payout - stake;
  const winBalance = initialBalance - stake + payout;
  const loseNet = -stake;
  const loseBalance = initialBalance - stake;
  const actualNet = actualResult === "win" ? winNet : loseNet;
  const actualBalance = actualResult === "win" ? winBalance : loseBalance;
  const planHasBet = currentPlan.bets.includes(selectedBet);

  return (
    <div className="min-h-screen bg-[#0b0e1a] text-white">
      {errorMessage && (
        <div className="sticky top-0 z-50 bg-red-900/90 border-b border-red-700 px-4 py-3 flex items-start gap-3 backdrop-blur">
          <span className="text-red-300 text-lg leading-none mt-0.5">!</span>
          <span className="flex-1 text-sm text-red-100 leading-snug">{errorMessage}</span>
          <button onClick={() => setErrorMessage(null)} className="text-red-300 hover:text-white text-lg leading-none flex-shrink-0">×</button>
        </div>
      )}

      <div className="sticky top-0 z-40 bg-[#0b0e1a]/95 border-b border-[#1e2235] backdrop-blur">
        <div className="max-w-lg mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLocation("/hash2")}
              className="text-slate-400 hover:text-white transition text-lg"
            >
              ←
            </button>
            <div>
              <div className="font-bold text-white">加拿大新版结算</div>
              <div className="text-[10px] text-slate-500">按当前加拿大模式方案赔率手工结算，不会真实下注</div>
            </div>
          </div>
          <button
            onClick={() => void logout()}
            className="text-xs px-2.5 py-0.5 rounded-full border border-red-500/40 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition"
          >
            退出
          </button>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-4 space-y-3 pb-24">
        <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-white font-semibold">加拿大新版结算页</div>
              <div className="text-slate-500 text-xs mt-1">
                例：初始金额 100，下注大 5，中奖后按所选方案赔率自动算余额
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-500">{user?.username}</div>
              <div className="text-[10px] text-slate-600">
                {loading ? "读取中..." : (config.updatedAt ? new Date(config.updatedAt).toLocaleString("zh-CN") : "-")}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
          <div className="text-white font-semibold text-sm mb-3">选择方案</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {config.plans.map((plan, index) => (
              <button
                key={plan.id}
                onClick={() => setActivePlan(index)}
                className={`px-3 py-2 rounded-xl text-sm border whitespace-nowrap transition ${
                  activePlan === index
                    ? "bg-purple-600 border-purple-500 text-white"
                    : "bg-[#0f1220] border-[#252a3d] text-slate-400 hover:text-slate-200"
                }`}
              >
                {plan.name || `方案${index + 1}`}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs mt-3">
            <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
              <div className="text-slate-500">已启用下注项</div>
              <div className="text-white mt-1 break-words">
                {enabledBetOptions.length ? enabledBetOptions.map(item => item.label).join(" / ") : "未设置"}
              </div>
            </div>
            <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
              <div className="text-slate-500">当前赔率</div>
              <div className="text-white mt-1">{formatAmount(currentOdds)} 倍</div>
            </div>
          </div>
        </div>

        <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4 space-y-4">
          <div className="text-white font-semibold text-sm">结算输入</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">初始金额</label>
              <NumericDraftInput
                value={initialBalance}
                min={0}
                onCommit={setInitialBalance}
                className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">下注金额</label>
              <NumericDraftInput
                value={stake}
                min={0}
                onCommit={setStake}
                className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1">下注项</label>
              <select
                value={selectedBet}
                onChange={e => setSelectedBet(e.target.value)}
                className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
              >
                {HASH2_BET_OPTIONS.map(item => (
                  <option key={item.key} value={item.key}>
                    {item.group} · {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-2">快捷选择</label>
              <div className="flex flex-wrap gap-2">
                {enabledBetOptions.length ? enabledBetOptions.map(item => {
                  const active = selectedBet === item.key;
                  return (
                    <button
                      key={item.key}
                      onClick={() => setSelectedBet(item.key)}
                      className={`px-3 py-1.5 rounded-xl text-sm border transition ${
                        active
                          ? "bg-purple-600 border-purple-500 text-white"
                          : "bg-[#0f1220] border-[#252a3d] text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                }) : (
                  <span className="text-xs text-slate-500">当前方案还没勾选下注项，也可以直接用上面的下拉框结算。</span>
                )}
              </div>
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1">实际结果</label>
              <select
                value={actualResult}
                onChange={e => setActualResult(e.target.value as "win" | "lose")}
                className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
              >
                <option value="win">中奖了</option>
                <option value="lose">没中</option>
              </select>
            </div>
          </div>
        </div>

        <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-white font-semibold text-sm">结算结果</div>
              <div className="text-slate-500 text-xs mt-1">
                当前按 {currentPlan.name} 的 {betLabel} 赔率结算
              </div>
            </div>
            <div className={`text-xs px-2 py-1 rounded-full border ${planHasBet ? "border-emerald-500/40 text-emerald-300" : "border-amber-500/40 text-amber-300"}`}>
              {planHasBet ? "在方案下注项内" : "仅按方案赔率试算"}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm mt-4">
            <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-3">
              <div className="text-slate-500 text-xs">中奖派彩</div>
              <div className="text-emerald-400 mt-1">{formatAmount(payout)}</div>
              <div className="text-[10px] text-slate-600 mt-1">{formatAmount(stake)} x {formatAmount(currentOdds)}</div>
            </div>
            <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-3">
              <div className="text-slate-500 text-xs">中奖净盈利</div>
              <div className="text-emerald-400 mt-1">+{formatAmount(winNet)}</div>
              <div className="text-[10px] text-slate-600 mt-1">派彩 - 本金</div>
            </div>
            <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-3">
              <div className="text-slate-500 text-xs">中奖后余额</div>
              <div className="text-white mt-1">{formatAmount(winBalance)}</div>
              <div className="text-[10px] text-slate-600 mt-1">{formatAmount(initialBalance)} - {formatAmount(stake)} + {formatAmount(payout)}</div>
            </div>
            <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-3">
              <div className="text-slate-500 text-xs">未中后余额</div>
              <div className="text-white mt-1">{formatAmount(loseBalance)}</div>
              <div className="text-[10px] text-slate-600 mt-1">{formatAmount(initialBalance)} - {formatAmount(stake)}</div>
            </div>
          </div>

          <div className={`mt-4 rounded-2xl border px-4 py-3 ${actualResult === "win" ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10"}`}>
            <div className="text-xs text-slate-300">实际结算</div>
            <div className="flex items-end justify-between gap-3 mt-1">
              <div>
                <div className="text-sm text-slate-300">
                  {betLabel} / {formatAmount(stake)} / {actualResult === "win" ? "中奖" : "未中"}
                </div>
                <div className={`text-xl font-semibold mt-1 ${actualNet >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                  {actualNet >= 0 ? "+" : ""}{formatAmount(actualNet)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-400">结算后余额</div>
                <div className="text-xl font-semibold text-white mt-1">{formatAmount(actualBalance)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
