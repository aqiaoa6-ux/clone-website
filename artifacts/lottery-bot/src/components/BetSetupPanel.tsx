import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ShieldAlert, Save, Loader2 } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────
export interface BetSetupConfig {
  stopLoss: number;
  targetProfit: number;
  maxConsecutiveLosses: number;
  cooldownSeconds: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave: (cfg: BetSetupConfig) => void;
  initialConfig?: Partial<BetSetupConfig>;
}

const DEFAULT_CONFIG: BetSetupConfig = {
  stopLoss: 5000,
  targetProfit: 3000,
  maxConsecutiveLosses: 5,
  cooldownSeconds: 0,
};

function NumField({
  label, sub, value, onChange, unit, presets, min, max,
}: {
  label: string;
  sub: string;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  presets: number[];
  min?: number;
  max?: number;
}) {
  return (
    <div className="bg-[#1a2035] border border-white/8 rounded-xl p-4 space-y-3">
      <div>
        <div className="text-sm font-medium text-white">{label}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>
      </div>
      <div className="relative flex items-center gap-2">
        {unit && (
          <span className="absolute left-3 text-muted-foreground text-sm select-none">{unit}</span>
        )}
        <input
          type="number"
          min={min ?? 0}
          max={max}
          value={value}
          onChange={e => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v) && v >= (min ?? 0)) onChange(v);
          }}
          className={`flex-1 bg-[#141824] border border-white/10 focus:border-[#3b5de7] rounded-xl ${unit ? 'pl-7' : 'pl-3'} pr-3 py-2.5 text-white text-sm outline-none transition-colors font-mono`}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map(p => (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${
              value === p
                ? 'bg-[#3b5de7] text-white'
                : 'bg-white/5 text-muted-foreground hover:text-white hover:bg-white/10'
            }`}
          >
            {p >= 10000 ? `${p / 10000}万` : p >= 1000 ? `${p / 1000}k` : p}
          </button>
        ))}
        {value === 0 && min === 0 && (
          <span className="text-[11px] text-muted-foreground px-1 self-center">（0 = 不限制）</span>
        )}
      </div>
    </div>
  );
}

export default function BetSetupPanel({ isOpen, onClose, onSave, initialConfig }: Props) {
  const [cfg, setCfg] = useState<BetSetupConfig>({ ...DEFAULT_CONFIG, ...initialConfig });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCfg({ ...DEFAULT_CONFIG, ...initialConfig });
      setSaved(false);
    }
  }, [isOpen]);

  async function handleSave() {
    setSaving(true);
    try {
      await fetch('/api/tg/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stopLoss: cfg.stopLoss,
          targetProfit: cfg.targetProfit,
          maxConsecutiveLosses: cfg.maxConsecutiveLosses,
          cooldownSeconds: cfg.cooldownSeconds,
        }),
      });
      onSave(cfg);
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 700);
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  function set(k: keyof BetSetupConfig) {
    return (v: number) => setCfg(p => ({ ...p, [k]: v }));
  }

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
            transition={{ type: 'tween', duration: 0.27 }}
            className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] bg-[#141824] rounded-t-2xl z-50 flex flex-col shadow-2xl"
          >
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
              <div className="w-10 h-1 rounded-full bg-white/20" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-2 pb-3 border-b border-white/10 flex-shrink-0">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-[#f44336]" />
                <span className="text-white font-semibold text-sm">风控设置</span>
              </div>
              <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Fields */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <NumField
                label="止损金额"
                sub="当日亏损超过此金额时自动停止投注（0 = 不限制）"
                value={cfg.stopLoss}
                onChange={set('stopLoss')}
                unit="¥"
                min={0}
                presets={[0, 1000, 2000, 5000, 10000, 20000]}
              />
              <NumField
                label="止盈金额"
                sub="当日盈利达到此金额时自动停止投注（0 = 不限制）"
                value={cfg.targetProfit}
                onChange={set('targetProfit')}
                unit="¥"
                min={0}
                presets={[0, 500, 1000, 3000, 5000, 10000]}
              />
              <NumField
                label="最大连亏次数"
                sub="连续亏损达到此次数时暂停投注（0 = 不限制）"
                value={cfg.maxConsecutiveLosses}
                onChange={set('maxConsecutiveLosses')}
                min={0}
                presets={[0, 3, 5, 8, 10, 15]}
              />
              <NumField
                label="触发后冷却时间（秒）"
                sub="风控触发后等待多少秒再恢复（0 = 需手动重启）"
                value={cfg.cooldownSeconds}
                onChange={set('cooldownSeconds')}
                min={0}
                presets={[0, 60, 120, 300, 600, 1800]}
              />
            </div>

            {/* Save */}
            <div className="px-4 pb-8 pt-3 border-t border-white/10 flex-shrink-0">
              <button
                onClick={handleSave}
                disabled={saving}
                className={`w-full h-11 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all ${
                  saved
                    ? 'bg-[#00e676] text-black'
                    : 'bg-[#3b5de7] hover:bg-blue-600 text-white disabled:opacity-40'
                }`}
              >
                {saving ? (
                  <><Loader2 className="w-4 h-4 animate-spin" />保存中...</>
                ) : saved ? (
                  '✓ 已保存'
                ) : (
                  <><Save className="w-4 h-4" />保存风控设置</>
                )}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
