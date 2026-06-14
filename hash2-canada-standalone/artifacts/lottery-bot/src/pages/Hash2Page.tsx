import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";
import BottomNav from "../components/BottomNav";
import TgAccessPanel from "../components/TgAccessPanel";
import { api, type Hash2Config, type Hash2Plan, type Hash2Runtime, type TgStatus } from "../lib/api";

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
  max,
  className,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
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
    next = Math.max(min, next);
    if (typeof max === "number") next = Math.min(max, next);
    onCommit(next);
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

function makeDefaultLevels(): number[] {
  return Array.from({ length: 60 }, (_, i) => i + 1);
}

function makeDefaultPlan(index: number): Hash2Plan {
  return {
    id: `plan-${index + 1}`,
    name: `方案${index + 1}`,
    enabled: false,
    bets: [],
    baseAmount: 0,
    handCount: 60,
    amountLevels: makeDefaultLevels(),
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

function makeDefaultConfig(): Hash2Config {
  return {
    plans: Array.from({ length: 5 }, (_, i) => makeDefaultPlan(i)),
    updatedAt: Date.now(),
  };
}

export default function Hash2Page() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [config, setConfig] = useState<Hash2Config>(makeDefaultConfig());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activePlan, setActivePlan] = useState(0);
  const [expandedLevels, setExpandedLevels] = useState<Record<string, boolean>>({});
  const [expandedOdds, setExpandedOdds] = useState<Record<string, boolean>>({});
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [testingAlert, setTestingAlert] = useState(false);
  const [tgStatus, setTgStatus] = useState<TgStatus | null>(null);
  const [runtime, setRuntime] = useState<Hash2Runtime | null>(null);
  const seenAlertStorageKey = "hash2_seen_alert_id";
  const [seenAlertId, setSeenAlertId] = useState<string>(() => sessionStorage.getItem(seenAlertStorageKey) ?? "");

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const [cfg, tg, rt] = await Promise.all([api.hash2.config(), api.tg.status(), api.hash2.runtime()]);
        if (!mounted) return;
        setConfig(cfg.plans?.length ? cfg : makeDefaultConfig());
        setTgStatus(tg);
        setRuntime(rt.runtime);
      } catch {
        if (!mounted) return;
        setConfig(makeDefaultConfig());
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const rt = await api.hash2.runtime();
          setRuntime(prev => {
            const next = rt.runtime;
            if (!prev) return next;
            if (prev.updatedAt === next.updatedAt) return prev;
            return next;
          });
        } catch {
          // ignore poll errors
        }
      })();
    }, 4000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const latest = runtime?.lastAlert;
    if (!latest || latest.id === seenAlertId) return;
    setSeenAlertId(latest.id);
    sessionStorage.setItem(seenAlertStorageKey, latest.id);
    setAlertMessage(latest.message);
    if (!latest.voice) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      const utterance = new SpeechSynthesisUtterance(latest.message);
      utterance.lang = "zh-CN";
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch {
      // ignore browser voice failures
    }
  }, [runtime?.lastAlert, seenAlertId]);

  const currentPlan = config.plans[activePlan] ?? makeDefaultPlan(activePlan);
  const currentPlanRuntime = currentPlan ? runtime?.plans?.[currentPlan.id] : undefined;
  const currentLevelSummary = useMemo(() => {
    if (!currentPlan.bets.length) return "";
    return `同方案共用层级 · 任意命中回第1手 · 全部未中才进下一手`;
  }, [currentPlan.bets.length]);
  const currentPreview = useMemo(() => {
    const amount = currentPlan.amountLevels[0] ?? currentPlan.baseAmount ?? 0;
    const targetFirst = currentPlan.bets.some(key => key.startsWith("num:")) || currentPlan.format === "target_first";
    return currentPlan.bets
      .map(key => {
        const label = HASH2_BET_OPTIONS.find(item => item.key === key)?.label ?? key;
        const amt = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
        return targetFirst ? `${label}/${amt}` : `${amt}/${label}`;
      })
      .join("  ");
  }, [currentPlan]);
  const selectedLabels = useMemo(() => {
    return currentPlan.bets
      .map(key => HASH2_BET_OPTIONS.find(item => item.key === key)?.label ?? key)
      .join(" / ");
  }, [currentPlan.bets]);

  const updatePlan = (index: number, patch: Partial<Hash2Plan>) => {
    setConfig(prev => ({
      ...prev,
      plans: prev.plans.map((plan, i) => i === index ? { ...plan, ...patch } : plan),
      updatedAt: Date.now(),
    }));
  };

  const toggleBet = (betKey: string) => {
    const exists = currentPlan.bets.includes(betKey);
    updatePlan(activePlan, {
      bets: exists
        ? currentPlan.bets.filter(item => item !== betKey)
        : [...currentPlan.bets, betKey],
    });
  };

  const setLevel = (levelIndex: number, value: string) => {
    const next = [...currentPlan.amountLevels];
    next[levelIndex] = Math.max(0, Number(value) || 0);
    updatePlan(activePlan, { amountLevels: next });
  };

  const setNumberOdd = (num: number, value: string) => {
    updatePlan(activePlan, {
      numberOdds: {
        ...currentPlan.numberOdds,
        [String(num)]: Math.max(0, Number(value) || 0),
      },
    });
  };

  const setBasicOdd = (key: keyof Hash2Plan["basicOdds"], value: string) => {
    updatePlan(activePlan, {
      basicOdds: {
        ...currentPlan.basicOdds,
        [key]: Math.max(0, Number(value) || 0),
      },
    });
  };

  const setComboOdd = (key: keyof Hash2Plan["comboOdds"], value: string) => {
    updatePlan(activePlan, {
      comboOdds: {
        ...currentPlan.comboOdds,
        [key]: Math.max(0, Number(value) || 0),
      },
    });
  };

  const setSpecialOdd = (key: keyof Hash2Plan["specialOdds"], value: string) => {
    updatePlan(activePlan, {
      specialOdds: {
        ...currentPlan.specialOdds,
        [key]: Math.max(0, Number(value) || 0),
      },
    });
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      const { config: saved } = await api.hash2.saveConfig(config);
      setConfig(saved);
      const rt = await api.hash2.runtime();
      setRuntime(rt.runtime);
      setAlertMessage("哈希2配置已保存");
    } catch (e) {
      setAlertMessage(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const testAlert = async () => {
    setTestingAlert(true);
    try {
      const res = await api.hash2.testAlert("哈希2提醒测试：网页提醒已触发");
      setAlertMessage(res.message);
      const rt = await api.hash2.runtime();
      setRuntime(rt.runtime);
    } catch (e) {
      setAlertMessage(e instanceof Error ? e.message : "提醒测试失败");
    } finally {
      setTestingAlert(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0b0e1a] text-white">
      {alertMessage && (
        <div className="sticky top-0 z-50 bg-purple-900/90 border-b border-purple-700 px-4 py-3 flex items-start gap-3 backdrop-blur">
          <span className="text-purple-300 text-lg leading-none mt-0.5">#</span>
          <span className="flex-1 text-sm text-purple-100 leading-snug">{alertMessage}</span>
          <button onClick={() => setAlertMessage(null)} className="text-purple-300 hover:text-white text-lg leading-none flex-shrink-0">×</button>
        </div>
      )}

      <div className="sticky top-0 z-40 bg-[#0b0e1a]/95 border-b border-[#1e2235] backdrop-blur">
        <div className="max-w-lg mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLocation("/")}
              className="text-slate-400 hover:text-white transition text-lg"
            >
              ←
            </button>
            <div>
              <div className="font-bold text-white">哈希2</div>
              <div className="text-[10px] text-slate-500">独立模块，不影响原哈希</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {user?.isAdmin && (
              <button
                onClick={() => setLocation("/admin")}
                className="text-xs px-2.5 py-0.5 rounded-full border border-blue-500/40 text-blue-300 hover:bg-blue-500/20 hover:text-blue-200 transition"
              >
                后台
              </button>
            )}
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
        <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white font-semibold">独立配置模块</div>
              <div className="text-slate-500 text-xs mt-1">
                玩法1/玩法2可同时配置，最多保留 5 套方案，每套独立 60 手
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-500">{user?.username}</div>
              <div className="text-[10px] text-slate-600">
                {config.updatedAt ? new Date(config.updatedAt).toLocaleString("zh-CN") : "-"}
              </div>
            </div>
          </div>
        </div>

        <TgAccessPanel
          tgStatus={tgStatus}
          onStatusChange={status => setTgStatus(status)}
        />

        <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
          <div className="text-white font-semibold text-sm mb-2">运行环境</div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
              <div className="text-slate-500">TG 连接</div>
              <div className={tgStatus?.connected ? "text-emerald-400 mt-1" : "text-red-400 mt-1"}>
                {tgStatus?.connected ? "已连接" : "未连接"}
              </div>
            </div>
            <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
              <div className="text-slate-500">投注群组</div>
              <div className="text-white mt-1 truncate">
                {tgStatus?.watchGroupTitle ?? "未选择"}
              </div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
              <div className="text-slate-500">当前期号</div>
              <div className="text-white mt-1">{runtime?.activePeriod ?? "等待中"}</div>
            </div>
            <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
              <div className="text-slate-500">最近提醒</div>
              <div className="text-white mt-1 truncate">{runtime?.lastAlert?.message ?? "暂无"}</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <button
              onClick={() => void testAlert()}
              disabled={testingAlert}
              className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm py-2 rounded-xl transition"
            >
              {testingAlert ? "测试中..." : "测试网页提醒"}
            </button>
            <button
              onClick={() => void saveConfig()}
              disabled={saving}
              className="bg-[#252a3d] hover:bg-[#30375a] disabled:opacity-50 text-slate-200 text-sm py-2 rounded-xl transition"
            >
              {saving ? "保存中..." : "保存哈希2"}
            </button>
            <button
              onClick={() => setLocation("/hash2/settle")}
              className="bg-[#1f4fd1] hover:bg-[#2a5ee9] text-white text-sm py-2 rounded-xl transition"
            >
              结算页面
            </button>
          </div>
        </div>

        <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
          <div className="text-white font-semibold text-sm mb-3">方案列表</div>
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
        </div>

        {!loading && (
          <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-white font-semibold">{currentPlan.name}</div>
                <div className="text-xs text-slate-500 mt-1">
                  已选下注项：{selectedLabels || "暂无"}
                </div>
                <div className="text-[10px] text-slate-600 mt-1 break-all">
                  发送预览：{currentPreview || "暂无"}
                </div>
              </div>
              <button
                onClick={() => updatePlan(activePlan, { enabled: !currentPlan.enabled })}
                className={`relative w-14 h-7 rounded-full transition-colors ${currentPlan.enabled ? "bg-purple-600" : "bg-[#252a3d]"}`}
              >
                <div className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow transition-all ${currentPlan.enabled ? "left-8" : "left-1"}`} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
                <div className="text-slate-500">当前层级</div>
                <div className="text-white mt-1">第{(currentPlanRuntime?.currentLevel ?? 0) + 1}手</div>
                <div className="text-[10px] text-slate-500 mt-1 truncate">
                  {currentLevelSummary || "暂无"}
                </div>
              </div>
              <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
                <div className="text-slate-500">累计盈亏</div>
                <div className={`${(currentPlanRuntime?.sessionPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"} mt-1`}>
                  {(currentPlanRuntime?.sessionPnl ?? 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
                <div className="text-slate-500">最近发单</div>
                <div className="text-white mt-1 truncate">{currentPlanRuntime?.lastMessage || "暂无"}</div>
              </div>
              <div className="rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
                <div className="text-slate-500">状态</div>
                <div className={`${currentPlanRuntime?.blockedReason ? "text-red-400" : "text-emerald-400"} mt-1 truncate`}>
                  {currentPlanRuntime?.blockedReason ?? "运行中/待触发"}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">方案名称</label>
                <input
                  value={currentPlan.name}
                  onChange={e => updatePlan(activePlan, { name: e.target.value })}
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">押注格式</label>
                <select
                  value={currentPlan.format}
                  onChange={e => updatePlan(activePlan, { format: e.target.value as Hash2Plan["format"] })}
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
                >
                  <option value="amount_first">金额/目标</option>
                  <option value="target_first">目标/金额</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">基础金额</label>
                <NumericDraftInput
                  value={currentPlan.baseAmount}
                  min={0}
                  onCommit={value => updatePlan(activePlan, { baseAmount: value })}
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">手数上限</label>
                <NumericDraftInput
                  value={currentPlan.handCount}
                  min={1}
                  max={60}
                  onCommit={value => updatePlan(activePlan, { handCount: value })}
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">止损</label>
                <NumericDraftInput
                  value={currentPlan.stopLoss}
                  min={0}
                  onCommit={value => updatePlan(activePlan, { stopLoss: value })}
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">止盈</label>
                <NumericDraftInput
                  value={currentPlan.targetProfit}
                  min={0}
                  onCommit={value => updatePlan(activePlan, { targetProfit: value })}
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 text-sm">
              <label className="flex items-center justify-between rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
                <span className="text-slate-300">金额为 0 仍保持脚本运行</span>
                <input
                  type="checkbox"
                  checked={currentPlan.zeroAmountRuns}
                  onChange={e => updatePlan(activePlan, { zeroAmountRuns: e.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
                <span className="text-slate-300">网页提醒</span>
                <input
                  type="checkbox"
                  checked={currentPlan.webAlertEnabled}
                  onChange={e => updatePlan(activePlan, { webAlertEnabled: e.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
                <span className="text-slate-300">语音播报</span>
                <input
                  type="checkbox"
                  checked={currentPlan.voiceAlertEnabled}
                  onChange={e => updatePlan(activePlan, { voiceAlertEnabled: e.target.checked })}
                />
              </label>
            </div>

            {currentPlan.enabled && currentPlan.bets.length > 0 && (currentPlan.amountLevels[0] ?? currentPlan.baseAmount ?? 0) === 0 && (
              <div className="mt-2 text-xs rounded-xl border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 px-3 py-2">
                当前金额为 0：只会虚拟运行，不会往群里发投注。把第1手金额/基础金额改成大于 0 才会下注。
              </div>
            )}

            <div>
              <div className="text-white font-semibold text-sm mb-2">玩法1</div>
              <div className="flex flex-wrap gap-2">
                {HASH2_BET_OPTIONS.filter(item => item.group === "玩法1").map(item => {
                  const active = currentPlan.bets.includes(item.key);
                  return (
                    <button
                      key={item.key}
                      onClick={() => toggleBet(item.key)}
                      className={`px-3 py-1.5 rounded-xl text-sm border transition ${
                        active
                          ? "bg-red-500/20 border-red-500/40 text-red-300"
                          : "bg-[#0f1220] border-[#252a3d] text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-white font-semibold text-sm mb-2">玩法2</div>
              <div className="flex flex-wrap gap-2">
                {HASH2_BET_OPTIONS.filter(item => item.group === "玩法2").map(item => {
                  const active = currentPlan.bets.includes(item.key);
                  return (
                    <button
                      key={item.key}
                      onClick={() => toggleBet(item.key)}
                      className={`px-2.5 py-1.5 rounded-xl text-sm border transition ${
                        active
                          ? "bg-blue-500/20 border-blue-500/40 text-blue-300"
                          : "bg-[#0f1220] border-[#252a3d] text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-2xl border border-[#252a3d] overflow-hidden">
              <button
                onClick={() => setExpandedLevels(prev => ({ ...prev, [currentPlan.id]: !prev[currentPlan.id] }))}
                className="w-full px-4 py-3 flex items-center justify-between text-left bg-[#111526]"
              >
                <span className="text-white font-semibold text-sm">60 手金额配置</span>
                <span className="text-slate-500 text-xs">
                  {expandedLevels[currentPlan.id] ? "收起" : `展开 · 第1手 ${currentPlan.amountLevels[0] ?? 0}`}
                </span>
              </button>
              <div className="px-4 pt-3 text-[10px] text-slate-500 bg-[#111526]">
                未中自动进下一手，命中任意下注项后回到第 1 手
              </div>
              {expandedLevels[currentPlan.id] && (
                <div className="grid grid-cols-4 gap-2 p-3">
                  {Array.from({ length: 60 }, (_, i) => (
                    <div key={i}>
                      <label className="block text-[10px] text-slate-600 mb-1">第{i + 1}手</label>
                      <NumericDraftInput
                        value={currentPlan.amountLevels[i] ?? 0}
                        min={0}
                        onCommit={value => setLevel(i, String(value))}
                        className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-[#252a3d] overflow-hidden">
              <div className="w-full px-4 py-3 text-left bg-[#111526]">
                <span className="text-white font-semibold text-sm">大小单双自定义赔率</span>
              </div>
              <div className="grid grid-cols-2 gap-2 p-3">
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">大赔率</label>
                  <NumericDraftInput
                    value={currentPlan.basicOdds.big ?? 2}
                    min={0}
                    onCommit={value => setBasicOdd("big", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">小赔率</label>
                  <NumericDraftInput
                    value={currentPlan.basicOdds.small ?? 2}
                    min={0}
                    onCommit={value => setBasicOdd("small", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">单赔率</label>
                  <NumericDraftInput
                    value={currentPlan.basicOdds.odd ?? 2}
                    min={0}
                    onCommit={value => setBasicOdd("odd", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">双赔率</label>
                  <NumericDraftInput
                    value={currentPlan.basicOdds.even ?? 2}
                    min={0}
                    onCommit={value => setBasicOdd("even", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[#252a3d] overflow-hidden">
              <div className="w-full px-4 py-3 text-left bg-[#111526]">
                <span className="text-white font-semibold text-sm">组合自定义赔率</span>
              </div>
              <div className="grid grid-cols-2 gap-2 p-3">
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">大单赔率</label>
                  <NumericDraftInput
                    value={currentPlan.comboOdds["big-odd"] ?? 4.2}
                    min={0}
                    onCommit={value => setComboOdd("big-odd", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">大双赔率</label>
                  <NumericDraftInput
                    value={currentPlan.comboOdds["big-even"] ?? 4.2}
                    min={0}
                    onCommit={value => setComboOdd("big-even", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">小单赔率</label>
                  <NumericDraftInput
                    value={currentPlan.comboOdds["small-odd"] ?? 4.2}
                    min={0}
                    onCommit={value => setComboOdd("small-odd", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">小双赔率</label>
                  <NumericDraftInput
                    value={currentPlan.comboOdds["small-even"] ?? 4.2}
                    min={0}
                    onCommit={value => setComboOdd("small-even", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[#252a3d] overflow-hidden">
              <button
                onClick={() => setExpandedOdds(prev => ({ ...prev, [currentPlan.id]: !prev[currentPlan.id] }))}
                className="w-full px-4 py-3 flex items-center justify-between text-left bg-[#111526]"
              >
                <span className="text-white font-semibold text-sm">0-27 自定义赔率</span>
                <span className="text-slate-500 text-xs">
                  {expandedOdds[currentPlan.id] ? "收起" : "展开"}
                </span>
              </button>
              {expandedOdds[currentPlan.id] && (
                <div className="grid grid-cols-4 gap-2 p-3">
                  {Array.from({ length: 28 }, (_, i) => (
                    <div key={i}>
                      <label className="block text-[10px] text-slate-600 mb-1">{i}号赔率</label>
                      <NumericDraftInput
                        value={currentPlan.numberOdds[String(i)] ?? 0}
                        min={0}
                        onCommit={value => setNumberOdd(i, String(value))}
                        className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-[#252a3d] overflow-hidden">
              <div className="w-full px-4 py-3 text-left bg-[#111526]">
                <span className="text-white font-semibold text-sm">特殊玩法自定义赔率</span>
              </div>
              <div className="grid grid-cols-2 gap-2 p-3">
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">极大赔率</label>
                  <NumericDraftInput
                    value={currentPlan.specialOdds["extreme-big"] ?? 15}
                    min={0}
                    onCommit={value => setSpecialOdd("extreme-big", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">极小赔率</label>
                  <NumericDraftInput
                    value={currentPlan.specialOdds["extreme-small"] ?? 15}
                    min={0}
                    onCommit={value => setSpecialOdd("extreme-small", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">豹子赔率</label>
                  <NumericDraftInput
                    value={currentPlan.specialOdds.leopard ?? 88}
                    min={0}
                    onCommit={value => setSpecialOdd("leopard", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">对子赔率</label>
                  <NumericDraftInput
                    value={currentPlan.specialOdds.pair ?? 3.4}
                    min={0}
                    onCommit={value => setSpecialOdd("pair", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-600 mb-1">顺子赔率</label>
                  <NumericDraftInput
                    value={currentPlan.specialOdds.straight ?? 18}
                    min={0}
                    onCommit={value => setSpecialOdd("straight", String(value))}
                    className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <BottomNav />
    </div>
  );
}
