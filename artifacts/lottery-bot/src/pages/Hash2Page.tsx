import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";
import BottomNav from "../components/BottomNav";
import { api, type Hash2Config, type Hash2Plan, type TgStatus } from "../lib/api";

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
    handCount: 1,
    amountLevels: makeDefaultLevels(),
    stopLoss: 0,
    targetProfit: 0,
    zeroAmountRuns: true,
    format: "amount_first",
    webAlertEnabled: true,
    voiceAlertEnabled: true,
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
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [testingAlert, setTestingAlert] = useState(false);
  const [tgStatus, setTgStatus] = useState<TgStatus | null>(null);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const [cfg, tg] = await Promise.all([api.hash2.config(), api.tg.status()]);
        if (!mounted) return;
        setConfig(cfg.plans?.length ? cfg : makeDefaultConfig());
        setTgStatus(tg);
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
    if (!alertMessage) return;
    const voiceEnabled = config.plans.some(p => p.voiceAlertEnabled);
    if (!voiceEnabled) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      const utterance = new SpeechSynthesisUtterance(alertMessage);
      utterance.lang = "zh-CN";
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch {
      // ignore browser voice failures
    }
  }, [alertMessage, config.plans]);

  const currentPlan = config.plans[activePlan] ?? makeDefaultPlan(activePlan);
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

  const saveConfig = async () => {
    setSaving(true);
    try {
      const { config: saved } = await api.hash2.saveConfig(config);
      setConfig(saved);
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
      const res = await api.hash2.testAlert("哈希2提醒测试：止盈止损网页提醒已触发");
      setAlertMessage(res.message);
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
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void testAlert()}
              disabled={testingAlert}
              className="flex-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm py-2 rounded-xl transition"
            >
              {testingAlert ? "测试中..." : "测试网页提醒"}
            </button>
            <button
              onClick={() => void saveConfig()}
              disabled={saving}
              className="flex-1 bg-[#252a3d] hover:bg-[#30375a] disabled:opacity-50 text-slate-200 text-sm py-2 rounded-xl transition"
            >
              {saving ? "保存中..." : "保存哈希2"}
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
              </div>
              <button
                onClick={() => updatePlan(activePlan, { enabled: !currentPlan.enabled })}
                className={`relative w-14 h-7 rounded-full transition-colors ${currentPlan.enabled ? "bg-purple-600" : "bg-[#252a3d]"}`}
              >
                <div className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow transition-all ${currentPlan.enabled ? "left-8" : "left-1"}`} />
              </button>
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
                  <option value="amount_first">金额 + 目标</option>
                  <option value="target_first">目标 + 金额</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">基础金额</label>
                <input
                  type="number"
                  min="0"
                  value={currentPlan.baseAmount}
                  onChange={e => updatePlan(activePlan, { baseAmount: Math.max(0, Number(e.target.value) || 0) })}
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">手数上限</label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={currentPlan.handCount}
                  onChange={e => updatePlan(activePlan, { handCount: Math.min(60, Math.max(1, Number(e.target.value) || 1)) })}
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">止损</label>
                <input
                  type="number"
                  min="0"
                  value={currentPlan.stopLoss}
                  onChange={e => updatePlan(activePlan, { stopLoss: Math.max(0, Number(e.target.value) || 0) })}
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">止盈</label>
                <input
                  type="number"
                  min="0"
                  value={currentPlan.targetProfit}
                  onChange={e => updatePlan(activePlan, { targetProfit: Math.max(0, Number(e.target.value) || 0) })}
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
              {expandedLevels[currentPlan.id] && (
                <div className="grid grid-cols-4 gap-2 p-3">
                  {Array.from({ length: 60 }, (_, i) => (
                    <div key={i}>
                      <label className="block text-[10px] text-slate-600 mb-1">第{i + 1}手</label>
                      <input
                        type="number"
                        min="0"
                        value={currentPlan.amountLevels[i] ?? 0}
                        onChange={e => setLevel(i, e.target.value)}
                        className="w-full bg-[#0f1220] border border-[#252a3d] rounded-lg px-2 py-1.5 text-white text-xs"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <BottomNav />
    </div>
  );
}
