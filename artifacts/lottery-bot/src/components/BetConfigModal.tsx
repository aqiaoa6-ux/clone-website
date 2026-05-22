import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronRight, Settings2, ShieldAlert, TrendingUp, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

export interface BetConfig {
  autoBet: boolean;
  betAmount: number;
  strategy: 'normal' | 'martingale' | 'anti-martingale';
  betMultiplier: number;
  maxConsecutiveLosses: number;
  stopLoss: number;
  targetProfit: number;
  cooldownSeconds: number;
  betType: 'follow' | 'big' | 'small' | 'odd' | 'even' | 'big-odd' | 'big-even' | 'small-odd' | 'small-even';
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: BetConfig) => void;
  initialConfig?: Partial<BetConfig>;
}

const defaultConfig: BetConfig = {
  autoBet: false,
  betAmount: 100,
  strategy: 'normal',
  betMultiplier: 2,
  maxConsecutiveLosses: 5,
  stopLoss: 5000,
  targetProfit: 3000,
  cooldownSeconds: 0,
  betType: 'follow',
};

const BET_TYPE_LABELS: Record<BetConfig['betType'], string> = {
  follow: '跟单（自动识别信号）',
  big: '大',
  small: '小',
  odd: '单',
  even: '双',
  'big-odd': '大单',
  'big-even': '大双',
  'small-odd': '小单',
  'small-even': '小双',
};

const STRATEGY_INFO: Record<BetConfig['strategy'], { label: string; desc: string; color: string }> = {
  normal:         { label: '普通模式',   desc: '每局固定投注金额，不递增递减', color: '#4CA2FF' },
  martingale:     { label: '马丁格尔',   desc: '输后乘以倍率，赢后归回底注',    color: '#f44336' },
  'anti-martingale': { label: '反马丁',  desc: '赢后乘以倍率，输后归回底注',    color: '#00e676' },
};

type Tab = 'basic' | 'strategy' | 'risk';

export default function BetConfigModal({ isOpen, onClose, onSave, initialConfig }: Props) {
  const [tab, setTab] = useState<Tab>('basic');
  const [cfg, setCfg] = useState<BetConfig>({ ...defaultConfig, ...initialConfig });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCfg({ ...defaultConfig, ...initialConfig });
      setTab('basic');
      setSaved(false);
    }
  }, [isOpen, initialConfig]);

  function update<K extends keyof BetConfig>(key: K, value: BetConfig[K]) {
    setCfg(prev => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await fetch('/api/tg/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      onSave(cfg);
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 800);
    } catch {
    } finally {
      setSaving(false);
    }
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'basic',    label: '基础配置', icon: <Settings2 className="w-3.5 h-3.5" /> },
    { id: 'strategy', label: '策略配置', icon: <TrendingUp className="w-3.5 h-3.5" /> },
    { id: 'risk',     label: '风控设置', icon: <ShieldAlert className="w-3.5 h-3.5" /> },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 0.6 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black z-50"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'tween', duration: 0.28 }}
            className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] bg-[#141824] rounded-t-2xl z-50 flex flex-col shadow-2xl"
            style={{ maxHeight: '88vh' }}
          >
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-white/20" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-2 pb-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4 text-[#4CA2FF]" />
                <h2 className="text-base font-semibold text-white">投注配置</h2>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">自动投注</span>
                  <Switch
                    checked={cfg.autoBet}
                    onCheckedChange={v => update('autoBet', v)}
                    className="data-[state=checked]:bg-[#00e676] scale-90"
                  />
                </div>
                <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Auto-bet status banner */}
            <AnimatePresence>
              {cfg.autoBet && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="mx-4 mt-2 px-3 py-2 rounded-lg bg-[#00e676]/10 border border-[#00e676]/30 flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#00e676] animate-pulse flex-shrink-0" />
                    <span className="text-xs text-[#00e676]">自动投注已启用 — 收到信号将自动跟单</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Tabs */}
            <div className="flex mx-4 mt-3 bg-[#1e2538] rounded-xl p-1 gap-1">
              {tabs.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-all ${
                    tab === t.id
                      ? 'bg-[#3b5de7] text-white shadow-md'
                      : 'text-muted-foreground hover:text-white'
                  }`}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">

              {/* ── BASIC TAB ── */}
              {tab === 'basic' && (
                <>
                  <SectionCard title="底注金额">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-sm">¥</span>
                      <input
                        type="number"
                        min={1}
                        value={cfg.betAmount}
                        onChange={e => update('betAmount', Math.max(1, Number(e.target.value)))}
                        className="flex-1 bg-[#1e2538] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#3b5de7] text-right"
                      />
                    </div>
                    {/* Quick presets */}
                    <div className="flex gap-2 mt-2">
                      {[100, 500, 1000, 5000, 10000].map(v => (
                        <button
                          key={v}
                          onClick={() => update('betAmount', v)}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            cfg.betAmount === v
                              ? 'bg-[#3b5de7] text-white'
                              : 'bg-[#1e2538] text-muted-foreground hover:text-white'
                          }`}
                        >
                          {v >= 1000 ? `${v / 1000}k` : v}
                        </button>
                      ))}
                    </div>
                  </SectionCard>

                  <SectionCard title="投注类型">
                    <div className="grid grid-cols-2 gap-2">
                      {(Object.entries(BET_TYPE_LABELS) as [BetConfig['betType'], string][]).map(([val, label]) => (
                        <button
                          key={val}
                          onClick={() => update('betType', val)}
                          className={`py-2.5 px-3 rounded-lg text-xs font-medium text-left transition-colors flex items-center justify-between ${
                            cfg.betType === val
                              ? 'bg-[#3b5de7]/20 border border-[#3b5de7] text-white'
                              : 'bg-[#1e2538] border border-transparent text-muted-foreground hover:text-white'
                          }`}
                        >
                          <span>{label}</span>
                          {cfg.betType === val && <ChevronRight className="w-3 h-3 text-[#4CA2FF]" />}
                        </button>
                      ))}
                    </div>
                  </SectionCard>

                  <SectionCard title="发单冷却">
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={0} max={60} step={5}
                        value={cfg.cooldownSeconds}
                        onChange={e => update('cooldownSeconds', Number(e.target.value))}
                        className="flex-1 accent-[#3b5de7]"
                      />
                      <span className="text-white text-sm w-16 text-right">
                        {cfg.cooldownSeconds === 0 ? '无冷却' : `${cfg.cooldownSeconds}秒`}
                      </span>
                    </div>
                  </SectionCard>
                </>
              )}

              {/* ── STRATEGY TAB ── */}
              {tab === 'strategy' && (
                <>
                  <SectionCard title="投注策略">
                    <div className="space-y-2">
                      {(Object.entries(STRATEGY_INFO) as [BetConfig['strategy'], typeof STRATEGY_INFO[BetConfig['strategy']]][]).map(([key, info]) => (
                        <button
                          key={key}
                          onClick={() => update('strategy', key)}
                          className={`w-full p-3 rounded-xl text-left transition-all flex items-start gap-3 ${
                            cfg.strategy === key
                              ? 'bg-[#1e2538] border border-[#3b5de7]/50 ring-1 ring-[#3b5de7]/30'
                              : 'bg-[#1e2538] border border-transparent hover:border-white/10'
                          }`}
                        >
                          <div className="w-2 h-2 rounded-full mt-1 flex-shrink-0" style={{ backgroundColor: info.color }} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-sm font-medium text-white">{info.label}</span>
                              {cfg.strategy === key && (
                                <span className="text-[10px] px-1.5 py-0.5 bg-[#3b5de7]/30 text-[#4CA2FF] rounded-full">当前</span>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground">{info.desc}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </SectionCard>

                  {cfg.strategy !== 'normal' && (
                    <SectionCard title={cfg.strategy === 'martingale' ? '输后倍率' : '赢后倍率'}>
                      <div className="flex items-center gap-3">
                        <input
                          type="range" min={1.5} max={5} step={0.5}
                          value={cfg.betMultiplier}
                          onChange={e => update('betMultiplier', Number(e.target.value))}
                          className="flex-1 accent-[#3b5de7]"
                        />
                        <span className="text-white font-mono text-sm w-12 text-right">×{cfg.betMultiplier}</span>
                      </div>
                      <div className="flex gap-2 mt-2">
                        {[1.5, 2, 2.5, 3, 4].map(v => (
                          <button
                            key={v}
                            onClick={() => update('betMultiplier', v)}
                            className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                              cfg.betMultiplier === v
                                ? 'bg-[#3b5de7] text-white'
                                : 'bg-[#1e2538] text-muted-foreground hover:text-white'
                            }`}
                          >
                            ×{v}
                          </button>
                        ))}
                      </div>
                      {/* Simulation preview */}
                      <div className="mt-3 p-3 rounded-lg bg-[#0d1117] border border-white/5">
                        <div className="text-[10px] text-muted-foreground mb-2">连续{cfg.strategy === 'martingale' ? '输' : '赢'}模拟（底注 ¥{cfg.betAmount}）</div>
                        <div className="flex gap-2">
                          {[1,2,3,4,5].map(n => (
                            <div key={n} className="flex-1 text-center">
                              <div className="text-[10px] text-muted-foreground mb-1">第{n}局</div>
                              <div className="text-xs text-white font-mono">
                                ¥{Math.round(cfg.betAmount * Math.pow(cfg.betMultiplier, n - 1)).toLocaleString()}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </SectionCard>
                  )}
                </>
              )}

              {/* ── RISK TAB ── */}
              {tab === 'risk' && (
                <>
                  <SectionCard title="最大连亏局数">
                    <div className="flex items-center gap-3">
                      <input
                        type="range" min={1} max={20} step={1}
                        value={cfg.maxConsecutiveLosses}
                        onChange={e => update('maxConsecutiveLosses', Number(e.target.value))}
                        className="flex-1 accent-[#f44336]"
                      />
                      <span className="text-white font-mono text-sm w-14 text-right">{cfg.maxConsecutiveLosses}局</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">连亏超过此局数后自动暂停投注</p>
                  </SectionCard>

                  <SectionCard title="止损金额">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-sm">¥</span>
                      <input
                        type="number" min={0}
                        value={cfg.stopLoss}
                        onChange={e => update('stopLoss', Math.max(0, Number(e.target.value)))}
                        className="flex-1 bg-[#1e2538] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#f44336] text-right"
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">当期亏损达到此金额时自动停止（0=不限）</p>
                    <div className="flex gap-2 mt-2">
                      {[1000, 3000, 5000, 10000, 0].map(v => (
                        <button
                          key={v}
                          onClick={() => update('stopLoss', v)}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            cfg.stopLoss === v
                              ? 'bg-[#f44336]/20 border border-[#f44336]/50 text-[#f44336]'
                              : 'bg-[#1e2538] text-muted-foreground hover:text-white'
                          }`}
                        >
                          {v === 0 ? '不限' : v >= 1000 ? `${v / 1000}k` : v}
                        </button>
                      ))}
                    </div>
                  </SectionCard>

                  <SectionCard title="止盈金额">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-sm">¥</span>
                      <input
                        type="number" min={0}
                        value={cfg.targetProfit}
                        onChange={e => update('targetProfit', Math.max(0, Number(e.target.value)))}
                        className="flex-1 bg-[#1e2538] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00e676] text-right"
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">当期盈利达到此金额时自动停止（0=不限）</p>
                    <div className="flex gap-2 mt-2">
                      {[1000, 3000, 5000, 10000, 0].map(v => (
                        <button
                          key={v}
                          onClick={() => update('targetProfit', v)}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            cfg.targetProfit === v
                              ? 'bg-[#00e676]/20 border border-[#00e676]/50 text-[#00e676]'
                              : 'bg-[#1e2538] text-muted-foreground hover:text-white'
                          }`}
                        >
                          {v === 0 ? '不限' : v >= 1000 ? `${v / 1000}k` : v}
                        </button>
                      ))}
                    </div>
                  </SectionCard>

                  {/* Risk summary */}
                  <div className="p-3 rounded-xl bg-[#1e2538] border border-white/5">
                    <div className="text-[10px] text-muted-foreground mb-2 flex items-center gap-1.5">
                      <ShieldAlert className="w-3 h-3" />
                      风控摘要
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <div className="text-[10px] text-muted-foreground">止损</div>
                        <div className="text-xs font-medium text-[#f44336]">{cfg.stopLoss === 0 ? '不限' : `¥${cfg.stopLoss.toLocaleString()}`}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted-foreground">止盈</div>
                        <div className="text-xs font-medium text-[#00e676]">{cfg.targetProfit === 0 ? '不限' : `¥${cfg.targetProfit.toLocaleString()}`}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted-foreground">最大连亏</div>
                        <div className="text-xs font-medium text-[#c8a520]">{cfg.maxConsecutiveLosses}局</div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Save button */}
            <div className="px-4 pb-6 pt-3 border-t border-white/10">
              <Button
                className={`w-full h-11 text-sm font-semibold transition-all ${
                  saved
                    ? 'bg-[#00e676] hover:bg-[#00e676] text-black'
                    : 'bg-[#3b5de7] hover:bg-blue-600 text-white'
                }`}
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    保存中...
                  </span>
                ) : saved ? (
                  '✓ 已保存'
                ) : (
                  <span className="flex items-center gap-2">
                    <Save className="w-4 h-4" />
                    保存配置
                  </span>
                )}
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#1a2035] border border-white/8 rounded-xl p-4">
      <div className="text-xs text-muted-foreground mb-3 font-medium uppercase tracking-wide">{title}</div>
      {children}
    </div>
  );
}
