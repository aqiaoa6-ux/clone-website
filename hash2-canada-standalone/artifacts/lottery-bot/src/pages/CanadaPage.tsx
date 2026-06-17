import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";
import { BottomNavStatic } from "../components/BottomNav";
import TgAccessPanel from "../components/TgAccessPanel";
import { api, type CanadaConfig, type CanadaPlan, type CanadaRuntime, type TgStatus } from "../lib/api";

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
interface DrawState {
  term: number;
  sum1?: number;
  sum2?: number;
  sum3?: number;
  result?: number;
  nextCloseTime: number;
}

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

function makeDefaultPlan(index: number): CanadaPlan {
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

function makeDefaultConfig(): CanadaConfig {
  return {
    plans: Array.from({ length: 6 }, (_, i) => makeDefaultPlan(i)),
    updatedAt: Date.now(),
  };
}

export default function CanadaPage() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [config, setConfig] = useState<CanadaConfig>(makeDefaultConfig());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activePlan, setActivePlan] = useState(0);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [testingAlert, setTestingAlert] = useState(false);
  const [tgStatus, setTgStatus] = useState<TgStatus | null>(null);
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({
    intro: false,
    tg: false,
    live: true,
    plans: true,
    runtime: false,
    basic: true,
    play1: false,
    play2: false,
    levels: false,
    basicOdds: false,
    comboOdds: false,
    numOdds: false,
    specialOdds: false,
  });

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const [cfg, tg] = await Promise.all([api.canada.config(), api.tg.status()]);
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

  const currentPlan = config.plans[activePlan] ?? makeDefaultPlan(activePlan);
  const toggleSection = (key: string) => {
    setSectionOpen(prev => ({ ...prev, [key]: !prev[key] }));
  };
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
        if (key.startsWith("num:")) return targetFirst ? `${label}/${amt}` : `${amt}/${label}`;
        return targetFirst ? `${label}${amt}` : `${amt}${label}`;
      })
      .join("  ");
  }, [currentPlan]);
  const selectedLabels = useMemo(() => {
    return currentPlan.bets
      .map(key => HASH2_BET_OPTIONS.find(item => item.key === key)?.label ?? key)
      .join(" / ");
  }, [currentPlan.bets]);

  const updatePlan = (index: number, patch: Partial<CanadaPlan>) => {
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

  const setBasicOdd = (key: keyof CanadaPlan["basicOdds"], value: string) => {
    updatePlan(activePlan, {
      basicOdds: {
        ...currentPlan.basicOdds,
        [key]: Math.max(0, Number(value) || 0),
      },
    });
  };

  const setComboOdd = (key: keyof CanadaPlan["comboOdds"], value: string) => {
    updatePlan(activePlan, {
      comboOdds: {
        ...currentPlan.comboOdds,
        [key]: Math.max(0, Number(value) || 0),
      },
    });
  };

  const setSpecialOdd = (key: keyof CanadaPlan["specialOdds"], value: string) => {
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
      const { config: saved } = await api.canada.saveConfig(config);
      setConfig(saved);
      setAlertMessage("加拿大配置已保存");
    } catch (e) {
      setAlertMessage(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const testAlert = async () => {
    setTestingAlert(true);
    try {
      const res = await api.canada.testAlert("加拿大提醒测试：网页提醒已触发");
      setAlertMessage(res.message);
    } catch (e) {
      setAlertMessage(e instanceof Error ? e.message : "提醒测试失败");
    } finally {
      setTestingAlert(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0b0e1a] text-white" style={{ overflowAnchor: "none" }}>
      {alertMessage && (
        <div className="fixed top-3 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 items-start gap-3 rounded-2xl border border-purple-700 bg-purple-900/95 px-4 py-3 shadow-2xl backdrop-blur">
          <span className="text-purple-300 text-lg leading-none mt-0.5">#</span>
          <span className="flex-1 text-sm text-purple-100 leading-snug">{alertMessage}</span>
          <button onClick={() => setAlertMessage(null)} className="text-purple-300 hover:text-white text-lg leading-none flex-shrink-0">×</button>
        </div>
      )}

      <div className="bg-[#0b0e1a] border-b border-[#1e2235]">
        <div className="max-w-lg mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLocation("/")}
              className="text-slate-400 hover:text-white transition text-lg"
            >
              ←
            </button>
            <div>
              <div className="font-bold text-white">加拿大</div>
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
        <CollapseSection
          title="独立配置模块"
          summary={`${user?.username ?? ""}${config.updatedAt ? ` · ${new Date(config.updatedAt).toLocaleString("zh-CN")}` : ""}`}
          open={sectionOpen.intro}
          onToggle={() => toggleSection("intro")}
        >
          <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white font-semibold">独立配置模块</div>
              <div className="text-slate-500 text-xs mt-1">
                玩法1/玩法2可同时配置，最多保留 6 套方案，每套独立 60 手
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
        </CollapseSection>

        <CollapseSection
          title="TG 设置"
          summary={tgStatus?.watchGroupTitle ?? "未设置"}
          open={sectionOpen.tg}
          onToggle={() => toggleSection("tg")}
        >
          <TgAccessPanel
          tgStatus={tgStatus}
          onStatusChange={status => setTgStatus(status)}
          />
        </CollapseSection>

        <CollapseSection
          title="实时面板"
          summary="期号 / 倒计时 / 运行环境"
          open={sectionOpen.live}
          onToggle={() => toggleSection("live")}
        >
          <CanadaLiveOverview
          tgStatus={tgStatus}
          onAlert={message => setAlertMessage(message)}
          />
        </CollapseSection>

        <CollapseSection
          title="方案列表"
          summary={currentPlan.name || `方案${activePlan + 1}`}
          open={sectionOpen.plans}
          onToggle={() => toggleSection("plans")}
        >
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
        </CollapseSection>

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

            <CollapseSection
              title="运行状态"
              summary="层级 / 盈亏 / 状态"
              open={sectionOpen.runtime}
              onToggle={() => toggleSection("runtime")}
            >
              <CanadaPlanRuntimeSummary
                activePlanId={currentPlan.id}
                currentLevelSummary={currentLevelSummary}
              />
            </CollapseSection>

            <CollapseSection
              title="基础设置"
              summary={`${selectedLabels || "暂无"} · 基础金额 ${currentPlan.baseAmount || 0}`}
              open={sectionOpen.basic}
              onToggle={() => toggleSection("basic")}
            >
              <div className="space-y-4">
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
                      onChange={e => updatePlan(activePlan, { format: e.target.value as CanadaPlan["format"] })}
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
                    <label className="block text-xs text-slate-500 mb-1">不中切换手数</label>
                    <NumericDraftInput
                      value={currentPlan.handCount}
                      min={1}
                      max={60}
                      onCommit={value => updatePlan(activePlan, { handCount: value })}
                      className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
                    />
                    <div className="mt-1 text-[11px] text-slate-500">当前方案打到这手还没中，就自动跳到下一方案。</div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">止损金额</label>
                    <NumericDraftInput
                      value={currentPlan.stopLoss}
                      min={0}
                      onCommit={value => updatePlan(activePlan, { stopLoss: value })}
                      className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm"
                    />
                    <div className="mt-1 text-[11px] text-slate-500">止损只负责停用提醒，不再作为跳转下一方案的条件。</div>
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
              </div>
            </CollapseSection>

            <div className="grid grid-cols-2 gap-2">
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
                {saving ? "保存中..." : "保存加拿大"}
              </button>
            </div>

            {currentPlan.enabled && currentPlan.bets.length > 0 && (currentPlan.amountLevels[0] ?? currentPlan.baseAmount ?? 0) === 0 && (
              <div className="mt-2 text-xs rounded-xl border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 px-3 py-2">
                当前金额为 0：只会虚拟运行，不会往群里发投注。把第1手金额/基础金额改成大于 0 才会下注。
              </div>
            )}

            <CollapseSection
              title="玩法1"
              summary={HASH2_BET_OPTIONS.filter(item => item.group === "玩法1" && currentPlan.bets.includes(item.key)).map(item => item.label).join(" / ") || "未选择"}
              open={sectionOpen.play1}
              onToggle={() => toggleSection("play1")}
            >
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
            </CollapseSection>

            <CollapseSection
              title="玩法2"
              summary={HASH2_BET_OPTIONS.filter(item => item.group === "玩法2" && currentPlan.bets.includes(item.key)).map(item => item.label).join(" / ") || "未选择"}
              open={sectionOpen.play2}
              onToggle={() => toggleSection("play2")}
            >
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
            </CollapseSection>

            <CollapseSection
              title="60 手金额配置"
              summary={`第1手 ${currentPlan.amountLevels[0] ?? 0}`}
              open={sectionOpen.levels}
              onToggle={() => toggleSection("levels")}
            >
              <div className="text-[10px] text-slate-500 mb-3">
                未中自动进下一手，命中任意下注项后回到第 1 手
              </div>
              <div className="grid grid-cols-4 gap-2">
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
            </CollapseSection>

            <CollapseSection
              title="大小单双自定义赔率"
              summary="大 / 小 / 单 / 双"
              open={sectionOpen.basicOdds}
              onToggle={() => toggleSection("basicOdds")}
            >
              <div className="grid grid-cols-2 gap-2">
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
            </CollapseSection>

            <CollapseSection
              title="组合自定义赔率"
              summary="大单 / 大双 / 小单 / 小双"
              open={sectionOpen.comboOdds}
              onToggle={() => toggleSection("comboOdds")}
            >
              <div className="grid grid-cols-2 gap-2">
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
            </CollapseSection>

            <CollapseSection
              title="0-27 自定义赔率"
              summary="展开数字赔率"
              open={sectionOpen.numOdds}
              onToggle={() => toggleSection("numOdds")}
            >
              <div className="grid grid-cols-4 gap-2">
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
            </CollapseSection>

            <CollapseSection
              title="特殊玩法自定义赔率"
              summary="极大 / 极小 / 豹子 / 对子 / 顺子"
              open={sectionOpen.specialOdds}
              onToggle={() => toggleSection("specialOdds")}
            >
              <div className="grid grid-cols-2 gap-2">
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
            </CollapseSection>
          </div>
        )}
      </div>
      <BottomNavStatic />
    </div>
  );
}

function CanadaLiveOverview({
  tgStatus,
  onAlert,
}: {
  tgStatus: TgStatus | null;
  onAlert: (message: string) => void;
}) {
  const [runtime, setRuntime] = useState<CanadaRuntime | null>(null);
  const [draw, setDraw] = useState<DrawState | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const seenAlertStorageKey = "canada_seen_alert_id";
  const [seenAlertId, setSeenAlertId] = useState<string>(() => sessionStorage.getItem(seenAlertStorageKey) ?? "");
  const drawSigRef = useRef("");
  const nextCloseRef = useRef(0);

  const fetchRuntime = useCallback(async () => {
    try {
      const rt = await api.canada.runtime();
      setRuntime(prev => {
        const next = rt.runtime;
        if (!prev) return next;
        if (prev.updatedAt === next.updatedAt) return prev;
        return next;
      });
    } catch {
      // ignore runtime poll errors
    }
  }, []);

  const fetchDraw = useCallback(async () => {
    try {
      const data = await api.lottery.fengpan();
      const items = data?.message?.all?.keno28?.data ?? [];
      if (!items.length) return;
      const latest = items[0]!;
      const closeMs = latest.closeTime ?? 0;
      const openMs = latest.openTime ?? 0;
      const now = Date.now();
      const cycleMs = closeMs > openMs && closeMs - openMs < 600_000 ? closeMs - openMs : 210_000;
      const targetClose = closeMs > now ? closeMs : closeMs + cycleMs;
      nextCloseRef.current = targetClose > now ? targetClose : now + cycleMs;
      const next = {
        term: latest.term + (closeMs < now ? 1 : 0),
        sum1: latest.sum1,
        sum2: latest.sum2,
        sum3: latest.sum3,
        result: latest.result,
        nextCloseTime: nextCloseRef.current,
      };
      const sig = `${next.term}|${next.sum1}|${next.sum2}|${next.sum3}|${next.result}|${next.nextCloseTime}`;
      if (sig === drawSigRef.current) return;
      drawSigRef.current = sig;
      setDraw(next);
    } catch {
      // ignore draw poll errors
    }
  }, []);

  useEffect(() => {
    setNowMs(Date.now());
    void fetchRuntime();
    void fetchDraw();
    const runtimeId = window.setInterval(() => { void fetchRuntime(); }, 4000);
    const drawId = window.setInterval(() => { void fetchDraw(); }, 15000);
    return () => {
      window.clearInterval(runtimeId);
      window.clearInterval(drawId);
    };
  }, [fetchDraw, fetchRuntime]);

  useEffect(() => {
    if (!draw?.nextCloseTime) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [draw?.nextCloseTime]);

  useEffect(() => {
    const latest = runtime?.lastAlert;
    if (!latest || latest.id === seenAlertId) return;
    setSeenAlertId(latest.id);
    sessionStorage.setItem(seenAlertStorageKey, latest.id);
    onAlert(latest.message);
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
  }, [onAlert, runtime?.lastAlert, seenAlertId]);

  const periodLabel = draw?.term ? `${draw.term}期` : (runtime?.activePeriod ? `${runtime.activePeriod}期` : "等待中");
  const countdown = draw?.nextCloseTime ? Math.max(0, Math.floor((draw.nextCloseTime - nowMs) / 1000)) : 0;
  const cycleSec = 210;
  const pct = Math.min(100, Math.max(0, (countdown / cycleSec) * 100));
  const betZonePct = Math.min(100, (80 / cycleSec) * 100);
  const balls = [draw?.sum1, draw?.sum2, draw?.sum3].filter((value): value is number => typeof value === "number");
  const total = typeof draw?.result === "number" ? draw.result : balls.reduce((sum, value) => sum + value, 0);
  const sizeLabel = total >= 14 ? "大" : "小";
  const parityLabel = total % 2 === 0 ? "双" : "单";

  return (
    <>
      <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-5">
        <div className="flex justify-between items-start gap-3 mb-4">
          <div>
            <div className="text-slate-400 text-sm">当前期号</div>
            <div className="text-white text-3xl font-bold mt-1">{periodLabel}</div>
          </div>
          {balls.length === 3 && (
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {balls.map((value, index) => {
                const isAccent = index === 1;
                return (
                  <div key={`${index}-${value}`} className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${isAccent ? "bg-orange-500 text-white" : "bg-slate-600 text-white"}`}>
                    {value}
                  </div>
                );
              })}
              <span className="text-slate-500 text-lg">=</span>
              <div className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-bold">
                {total}
              </div>
              <div className="text-slate-300 text-sm">{sizeLabel}{parityLabel}</div>
            </div>
          )}
        </div>

        <div className="text-center py-2">
          <div className={`text-5xl font-bold font-mono tabular-nums tracking-tight ${countdown <= 80 && countdown > 0 ? "text-yellow-400" : "text-white"}`}>
            {String(Math.floor(countdown / 60)).padStart(2, "0")}:{String(countdown % 60).padStart(2, "0")}
          </div>
          <div className="text-slate-500 text-xs mt-1">距封盘倒计时</div>
        </div>

        <div className="mt-2">
          <div className="relative h-2 bg-[#0f1220] rounded-full overflow-hidden">
            <div className="absolute right-0 top-0 h-full rounded-full bg-yellow-500/20" style={{ width: `${betZonePct}%` }} />
            <div
              className={`absolute left-0 top-0 h-full rounded-full ${countdown <= 80 ? "bg-yellow-400" : "bg-blue-500"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-slate-600 mt-1">
            <span>开奖</span>
            <span className="text-yellow-600/70">←投注区间 01:20→</span>
            <span>封盘</span>
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
            <div className="text-white mt-1 truncate">{tgStatus?.watchGroupTitle ?? "未选择"}</div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
          <div className="min-h-[58px] rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
            <div className="text-slate-500">当前期号</div>
            <div className="mt-1 truncate text-white">{runtime?.activePeriod ?? "等待中"}</div>
          </div>
          <div className="min-h-[58px] rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
            <div className="text-slate-500">最近提醒</div>
            <div className="text-white mt-1 truncate">{runtime?.lastAlert?.message ?? "暂无"}</div>
          </div>
        </div>
      </div>
    </>
  );
}

function CanadaPlanRuntimeSummary({
  activePlanId,
  currentLevelSummary,
}: {
  activePlanId: string;
  currentLevelSummary: string;
}) {
  const [runtime, setRuntime] = useState<CanadaRuntime | null>(null);
  const [resetting, setResetting] = useState(false);

  const fetchRuntime = useCallback(async () => {
    try {
      const rt = await api.canada.runtime();
      setRuntime(prev => {
        const next = rt.runtime;
        if (!prev) return next;
        if (prev.updatedAt === next.updatedAt) return prev;
        return next;
      });
    } catch {
      // ignore runtime poll errors
    }
  }, []);

  useEffect(() => {
    void fetchRuntime();
    const id = window.setInterval(() => { void fetchRuntime(); }, 4000);
    return () => window.clearInterval(id);
  }, [activePlanId, fetchRuntime]);

  const currentPlanRuntime = runtime?.plans?.[activePlanId];
  const resetRuntime = async () => {
    setResetting(true);
    try {
      const res = await api.canada.resetRuntime(activePlanId);
      setRuntime(res.runtime);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="grid grid-cols-2 gap-3 text-xs">
      <div className="min-h-[74px] rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
        <div className="text-slate-500">当前层级</div>
        <div className="text-white mt-1">第{(currentPlanRuntime?.currentLevel ?? 0) + 1}手</div>
        <div className="text-[10px] text-slate-500 mt-1 truncate">
          {currentLevelSummary || "暂无"}
        </div>
      </div>
      <div className="min-h-[74px] rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
        <div className="text-slate-500">累计盈亏</div>
        <div className={`${(currentPlanRuntime?.sessionPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"} mt-1`}>
          {(currentPlanRuntime?.sessionPnl ?? 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
        </div>
        <button
          onClick={() => void resetRuntime()}
          disabled={resetting}
          className="mt-2 rounded-lg border border-[#30375a] px-2 py-1 text-[10px] text-slate-300 transition hover:bg-[#1a2033] disabled:opacity-50"
        >
          {resetting ? "清空中..." : "清空"}
        </button>
      </div>
      <div className="min-h-[74px] rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
        <div className="text-slate-500">最近发单</div>
        <div className="text-white mt-1 truncate">{currentPlanRuntime?.lastMessage || "暂无"}</div>
      </div>
      <div className="min-h-[74px] rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2">
        <div className="text-slate-500">状态</div>
        <div className={`${currentPlanRuntime?.blockedReason ? "text-red-400" : "text-emerald-400"} mt-1 truncate`}>
          {currentPlanRuntime?.blockedReason ?? "运行中/待触发"}
        </div>
      </div>
    </div>
  );
}

function CollapseSection({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-[#252a3d] overflow-hidden bg-[#161929]">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">{title}</div>
          {summary ? <div className="mt-1 truncate text-[11px] text-slate-500">{summary}</div> : null}
        </div>
        <span className="ml-3 shrink-0 text-xs text-slate-400">{open ? "收起" : "展开"}</span>
      </button>
      {open ? <div className="border-t border-[#252a3d] p-3">{children}</div> : null}
    </div>
  );
}

