import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Link, Users, Loader2, CheckCircle2, Plus, Trash2,
  Cpu, Settings2, ChevronRight, Save, RotateCcw,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────
export type PlayMode = 'normal' | 'double' | 'kill';
export type BetOption = 'big' | 'small' | 'odd' | 'even' | 'big-odd' | 'big-even' | 'small-odd' | 'small-even';
export type AlgorithmId = 'signal_follow' | 'signal_reverse' | 'streak_follow' | 'cold_pick' | 'random';

export interface BetSetupConfig {
  // group
  groupId?: string;
  groupTitle?: string;
  // amounts
  amountLevels: number[];
  stepBackOnWin: boolean;
  startLevel: number;
  // play mode
  playMode: PlayMode;
  doubleGroupA: BetOption;
  doubleGroupB: BetOption;
  killOption: BetOption;
  // bet options (normal mode)
  betOptions: BetOption[];
  // algorithms
  algorithms: AlgorithmId[];
  // general
  autoBet: boolean;
}

interface GroupInfo { id: string; title: string; type: string; }

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave: (cfg: BetSetupConfig) => void;
  initialConfig?: Partial<BetSetupConfig>;
  tgConnected?: boolean;
  currentGroupId?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG: BetSetupConfig = {
  amountLevels: [100, 200, 300, 500, 1000],
  stepBackOnWin: true,
  startLevel: 0,
  playMode: 'normal',
  doubleGroupA: 'big-odd',
  doubleGroupB: 'small-even',
  killOption: 'big-odd',
  betOptions: ['big', 'small'],
  algorithms: ['signal_follow'],
  autoBet: false,
};

const QUADRANT_OPTIONS: BetOption[] = ['big-odd', 'big-even', 'small-odd', 'small-even'];

const QUICK_PAIRS: Array<{ a: BetOption; b: BetOption; label: string }> = [
  { a: 'big-odd',   b: 'small-even', label: '大单 + 小双' },
  { a: 'small-odd', b: 'big-even',   label: '小单 + 大双' },
  { a: 'big',       b: 'small',      label: '大 + 小' },
  { a: 'odd',       b: 'even',       label: '单 + 双' },
];

function getEffectiveBetOptions(cfg: BetSetupConfig): BetOption[] {
  if (cfg.playMode === 'double') return [cfg.doubleGroupA, cfg.doubleGroupB];
  if (cfg.playMode === 'kill')   return QUADRANT_OPTIONS.filter(o => o !== cfg.killOption);
  return cfg.betOptions;
}

const BET_OPTION_META: { id: BetOption; label: string; color: string }[] = [
  { id: 'big',        label: '大',   color: '#f44336' },
  { id: 'small',      label: '小',   color: '#4CA2FF' },
  { id: 'odd',        label: '单',   color: '#c8a520' },
  { id: 'even',       label: '双',   color: '#10b981' },
  { id: 'big-odd',    label: '大单', color: '#f44336' },
  { id: 'big-even',   label: '大双', color: '#e040fb' },
  { id: 'small-odd',  label: '小单', color: '#4CA2FF' },
  { id: 'small-even', label: '小双', color: '#10b981' },
];

// Only 5 primary options shown
const PRIMARY_OPTIONS = BET_OPTION_META.slice(0, 5);

const ALGORITHM_META: { id: AlgorithmId; title: string; desc: string; badge: string; color: string }[] = [
  {
    id: 'signal_follow',
    title: '算法1 · 信号跟单',
    desc: '读取群内信号消息，跟随信号方向投注',
    badge: 'A1',
    color: '#4CA2FF',
  },
  {
    id: 'signal_reverse',
    title: '算法2 · 信号反单',
    desc: '读取群内信号，投注与信号相反的方向',
    badge: 'A2',
    color: '#e040fb',
  },
  {
    id: 'streak_follow',
    title: '算法3 · 连续追号',
    desc: '分析近期开奖，追投连续出现最多的结果',
    badge: 'A3',
    color: '#c8a520',
  },
  {
    id: 'cold_pick',
    title: '算法4 · 冷热切换',
    desc: '选择最近未出现的冷门结果，均值回归策略',
    badge: 'A4',
    color: '#10b981',
  },
  {
    id: 'random',
    title: '算法5 · 智能随机',
    desc: '在已启用的投注选项中随机选择，打乱规律',
    badge: 'A5',
    color: '#f44336',
  },
];

type Tab = 'group' | 'amount' | 'options' | 'algorithm';

// ── Component ──────────────────────────────────────────────────────────────────
export default function BetSetupPanel({ isOpen, onClose, onSave, initialConfig, tgConnected, currentGroupId }: Props) {
  const [tab, setTab] = useState<Tab>('group');
  const [cfg, setCfg] = useState<BetSetupConfig>({ ...DEFAULT_CONFIG, ...initialConfig });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // group tab state
  const [groupLink, setGroupLink] = useState('');
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [groupTab, setGroupTab] = useState<'link' | 'list'>('link');
  const [groupLoading, setGroupLoading] = useState(false);
  const [groupListLoading, setGroupListLoading] = useState(false);
  const [groupError, setGroupError] = useState('');

  // amount tab state
  const [newAmount, setNewAmount] = useState('');

  useEffect(() => {
    if (isOpen) {
      setCfg({ ...DEFAULT_CONFIG, ...initialConfig });
      setTab('group');
      setSaved(false);
      setGroupError('');
      if (tgConnected) loadGroups();
    }
  }, [isOpen]);

  async function loadGroups() {
    setGroupListLoading(true);
    try {
      const r = await fetch('/api/tg/groups');
      if (!r.ok) return;
      const d = await r.json() as { groups?: GroupInfo[] };
      setGroups(d.groups ?? []);
    } catch { /* ignore */ }
    finally { setGroupListLoading(false); }
  }

  async function handleResolveGroup() {
    const raw = groupLink.trim();
    if (!raw) { setGroupError('请输入群链接'); return; }
    setGroupLoading(true); setGroupError('');
    try {
      const r = await fetch('/api/tg/resolve-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link: raw }),
      });
      const d = await r.json() as { ok?: boolean; group?: GroupInfo; error?: string };
      if (!r.ok || !d.ok || !d.group) { setGroupError(d.error ?? '群链接无效'); return; }
      setCfg(p => ({ ...p, groupId: d.group!.id, groupTitle: d.group!.title }));
      setGroupLink('');
      setGroupError('');
    } catch { setGroupError('网络错误，请重试'); }
    finally { setGroupLoading(false); }
  }

  function selectGroup(g: GroupInfo) {
    setCfg(p => ({ ...p, groupId: g.id, groupTitle: g.title }));
  }

  function toggleBetOption(opt: BetOption) {
    setCfg(p => {
      const has = p.betOptions.includes(opt);
      if (has && p.betOptions.length === 1) return p; // keep at least 1
      return { ...p, betOptions: has ? p.betOptions.filter(o => o !== opt) : [...p.betOptions, opt] };
    });
  }

  function toggleAlgorithm(id: AlgorithmId) {
    setCfg(p => {
      const has = p.algorithms.includes(id);
      if (has && p.algorithms.length === 1) return p; // keep at least 1
      return { ...p, algorithms: has ? p.algorithms.filter(a => a !== id) : [...p.algorithms, id] };
    });
  }

  function selectAllAlgorithms() {
    setCfg(p => ({ ...p, algorithms: ALGORITHM_META.map(a => a.id) }));
  }

  function addAmountLevel() {
    const v = parseInt(newAmount, 10);
    if (!v || v <= 0) return;
    setCfg(p => ({ ...p, amountLevels: [...new Set([...p.amountLevels, v])].sort((a, b) => a - b) }));
    setNewAmount('');
  }

  function removeAmountLevel(idx: number) {
    setCfg(p => {
      const levels = p.amountLevels.filter((_, i) => i !== idx);
      if (levels.length === 0) return p;
      return { ...p, amountLevels: levels, startLevel: Math.min(p.startLevel, levels.length - 1) };
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Apply group
      if (cfg.groupId) {
        await fetch('/api/tg/set-group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupId: cfg.groupId }),
        });
      }
      // Apply full config
      await fetch('/api/tg/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoBet: cfg.autoBet,
          amountLevels: cfg.amountLevels,
          stepBackOnWin: cfg.stepBackOnWin,
          startLevel: cfg.startLevel,
          betOptions: getEffectiveBetOptions(cfg),
          algorithms: cfg.algorithms,
          playMode: cfg.playMode,
          doubleGroupA: cfg.doubleGroupA,
          doubleGroupB: cfg.doubleGroupB,
          killOption: cfg.killOption,
        }),
      });
      onSave(cfg);
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 700);
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'group',     label: '群组' },
    { id: 'amount',    label: '金额' },
    { id: 'options',   label: '选项' },
    { id: 'algorithm', label: '算法' },
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
            transition={{ type: 'tween', duration: 0.27 }}
            className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] bg-[#141824] rounded-t-2xl z-50 flex flex-col shadow-2xl"
            style={{ height: '90vh' }}
          >
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
              <div className="w-10 h-1 rounded-full bg-white/20" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-2 pb-3 border-b border-white/10 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4 text-[#4CA2FF]" />
                <span className="text-white font-semibold text-sm">智能投注设置</span>
                {cfg.groupTitle && (
                  <span className="text-[10px] px-2 py-0.5 bg-green-500/15 text-green-400 rounded-full border border-green-500/20 truncate max-w-[100px]">
                    {cfg.groupTitle}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* auto-bet quick toggle */}
                <button
                  onClick={() => setCfg(p => ({ ...p, autoBet: !p.autoBet }))}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium transition-all ${cfg.autoBet ? 'bg-[#00e676]/20 text-[#00e676] border border-[#00e676]/30' : 'bg-white/5 text-muted-foreground border border-white/10'}`}
                >
                  {cfg.autoBet ? '● 自动投注' : '○ 自动投注'}
                </button>
                <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/10 flex-shrink-0">
              {tabs.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex-1 py-2.5 text-xs font-medium transition-colors relative ${
                    tab === t.id ? 'text-white' : 'text-muted-foreground hover:text-white/70'
                  }`}
                >
                  {t.label}
                  {tab === t.id && (
                    <motion.div layoutId="tab-indicator" className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-[#3b5de7] rounded-full" />
                  )}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              <AnimatePresence mode="wait">

                {/* ── GROUP TAB ── */}
                {tab === 'group' && (
                  <motion.div key="group" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="p-4 space-y-3">

                    {!tgConnected && (
                      <div className="p-3 rounded-xl bg-[#c8a520]/10 border border-[#c8a520]/30 text-xs text-[#c8a520]">
                        ⚠️ 请先连接 Telegram 账号才能设置投注群
                      </div>
                    )}

                    {cfg.groupTitle && (
                      <div className="flex items-center gap-3 p-3 rounded-xl bg-green-500/10 border border-green-500/25">
                        <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-white font-medium truncate">{cfg.groupTitle}</div>
                          <div className="text-[10px] text-green-400 mt-0.5">已选择投注群</div>
                        </div>
                        <button onClick={() => setCfg(p => ({ ...p, groupId: undefined, groupTitle: undefined }))} className="text-muted-foreground hover:text-white">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}

                    {/* Sub-tabs */}
                    <div className="flex bg-[#1e2538] rounded-xl p-1 gap-1">
                      {[{ id: 'link' as const, label: '输入链接' }, { id: 'list' as const, label: '从列表选' }].map(st => (
                        <button key={st.id} onClick={() => setGroupTab(st.id)}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${groupTab === st.id ? 'bg-[#3b5de7] text-white' : 'text-muted-foreground'}`}
                        >
                          {st.label}
                        </button>
                      ))}
                    </div>

                    {groupTab === 'link' && (
                      <div>
                        <p className="text-muted-foreground text-xs mb-2 leading-relaxed">
                          输入群/频道链接，如 <span className="text-[#4CA2FF]">t.me/groupname</span> 或 <span className="text-[#4CA2FF]">@groupname</span>
                        </p>
                        <div className="relative mb-2">
                          <Link className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                          <input
                            value={groupLink}
                            onChange={e => { setGroupLink(e.target.value); setGroupError(''); }}
                            onKeyDown={e => e.key === 'Enter' && handleResolveGroup()}
                            placeholder="t.me/groupname 或 @groupname"
                            className="w-full bg-[#1e2538] border border-white/10 focus:border-[#3b5de7] rounded-xl pl-9 pr-3 py-2.5 text-white text-sm outline-none transition-colors"
                          />
                        </div>
                        {groupError && <p className="text-[#f44336] text-xs mb-2">{groupError}</p>}
                        <button
                          onClick={handleResolveGroup}
                          disabled={groupLoading || !groupLink.trim() || !tgConnected}
                          className="w-full bg-[#3b5de7] hover:bg-blue-600 disabled:opacity-40 text-white rounded-xl py-2.5 text-sm font-medium flex items-center justify-center gap-2 transition-colors"
                        >
                          {groupLoading ? <><Loader2 className="w-4 h-4 animate-spin" />解析中...</> : <><ChevronRight className="w-4 h-4" />确认群组</>}
                        </button>
                      </div>
                    )}

                    {groupTab === 'list' && (
                      <div>
                        {groupListLoading ? (
                          <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground text-sm">
                            <Loader2 className="w-4 h-4 animate-spin" />加载中...
                          </div>
                        ) : groups.length === 0 ? (
                          <div className="text-center py-10 text-muted-foreground text-sm">暂无群组</div>
                        ) : (
                          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-0.5">
                            {groups.map(g => (
                              <button key={g.id} onClick={() => selectGroup(g)}
                                className={`w-full flex items-center gap-3 p-3 rounded-xl transition-colors text-left ${
                                  cfg.groupId === g.id
                                    ? 'bg-[#3b5de7]/20 border border-[#3b5de7]/40'
                                    : 'bg-[#1e2538] border border-transparent hover:border-white/10'
                                }`}
                              >
                                <div className="w-8 h-8 rounded-full bg-[#2d3654] flex items-center justify-center flex-shrink-0">
                                  <Users className="w-4 h-4 text-[#4CA2FF]" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="text-white text-xs font-medium truncate">{g.title}</div>
                                  <div className="text-[10px] text-muted-foreground">{g.type === 'channel' ? '频道' : '群组'}</div>
                                </div>
                                {cfg.groupId === g.id && <CheckCircle2 className="w-4 h-4 text-[#3b5de7] flex-shrink-0" />}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </motion.div>
                )}

                {/* ── AMOUNT TAB ── */}
                {tab === 'amount' && (
                  <motion.div key="amount" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="p-4 space-y-4">

                    {/* Amount levels list */}
                    <div className="bg-[#1a2035] border border-white/8 rounded-xl p-4">
                      <div className="text-xs text-muted-foreground mb-3 flex items-center justify-between">
                        <span className="uppercase tracking-wide">投注金额序列</span>
                        <span className="text-[10px]">共{cfg.amountLevels.length}档</span>
                      </div>
                      <div className="space-y-2">
                        {cfg.amountLevels.map((amt, idx) => (
                          <div key={idx} className={`flex items-center gap-2 p-2.5 rounded-lg border transition-colors ${
                            idx === cfg.startLevel
                              ? 'bg-[#3b5de7]/15 border-[#3b5de7]/40'
                              : 'bg-[#1e2538] border-white/5'
                          }`}>
                            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
                              idx === cfg.startLevel ? 'bg-[#3b5de7] text-white' : 'bg-white/10 text-muted-foreground'
                            }`}>
                              {idx + 1}
                            </div>
                            <span className="flex-1 text-white text-sm font-mono">¥{amt.toLocaleString()}</span>
                            {idx === cfg.startLevel && (
                              <span className="text-[10px] text-[#4CA2FF] px-1.5 py-0.5 bg-[#3b5de7]/20 rounded-full">起始</span>
                            )}
                            <button
                              onClick={() => setCfg(p => ({ ...p, startLevel: idx }))}
                              className={`text-[10px] px-2 py-1 rounded-lg transition-colors ${
                                idx === cfg.startLevel ? 'text-[#4CA2FF]' : 'text-muted-foreground hover:text-white bg-white/5'
                              }`}
                              title="设为起始档"
                            >
                              {idx === cfg.startLevel ? '✓起始' : '设为起始'}
                            </button>
                            <button
                              onClick={() => removeAmountLevel(idx)}
                              disabled={cfg.amountLevels.length <= 1}
                              className="text-muted-foreground hover:text-[#f44336] disabled:opacity-30 p-1"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>

                      {/* Add new level */}
                      <div className="flex gap-2 mt-3">
                        <input
                          type="number"
                          min={1}
                          value={newAmount}
                          onChange={e => setNewAmount(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && addAmountLevel()}
                          placeholder="输入金额..."
                          className="flex-1 bg-[#141824] border border-white/10 focus:border-[#3b5de7] rounded-lg px-3 py-2 text-white text-sm outline-none placeholder:text-muted-foreground/40"
                        />
                        <button
                          onClick={addAmountLevel}
                          disabled={!newAmount || parseInt(newAmount) <= 0}
                          className="bg-[#3b5de7]/20 hover:bg-[#3b5de7]/40 disabled:opacity-30 text-[#4CA2FF] rounded-lg px-3 py-2 transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Quick add presets */}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {[50, 100, 200, 300, 500, 1000, 2000, 5000].map(v => (
                          <button
                            key={v}
                            onClick={() => {
                              if (!cfg.amountLevels.includes(v)) {
                                setCfg(p => ({ ...p, amountLevels: [...p.amountLevels, v].sort((a, b) => a - b) }));
                              }
                            }}
                            disabled={cfg.amountLevels.includes(v)}
                            className="text-[10px] px-2 py-1 rounded-lg bg-white/5 text-muted-foreground hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors"
                          >
                            +{v >= 1000 ? `${v / 1000}k` : v}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Step back on win */}
                    <div className="bg-[#1a2035] border border-white/8 rounded-xl p-4">
                      <div className="text-xs text-muted-foreground mb-3 uppercase tracking-wide">中奖策略</div>
                      <button
                        onClick={() => setCfg(p => ({ ...p, stepBackOnWin: !p.stepBackOnWin }))}
                        className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all ${
                          cfg.stepBackOnWin
                            ? 'bg-[#00e676]/10 border-[#00e676]/30'
                            : 'bg-[#1e2538] border-white/8'
                        }`}
                      >
                        <RotateCcw className={`w-4 h-4 flex-shrink-0 ${cfg.stepBackOnWin ? 'text-[#00e676]' : 'text-muted-foreground'}`} />
                        <div className="flex-1 text-left">
                          <div className={`text-xs font-medium ${cfg.stepBackOnWin ? 'text-white' : 'text-muted-foreground'}`}>
                            中奖后后退一档
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            中奖后金额降一级，连输后自动升级，保留盈利
                          </div>
                        </div>
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                          cfg.stepBackOnWin ? 'bg-[#00e676] border-[#00e676]' : 'border-white/20'
                        }`}>
                          {cfg.stepBackOnWin && <span className="text-black text-[10px] font-bold">✓</span>}
                        </div>
                      </button>

                      {/* Amount ladder preview */}
                      <div className="mt-3 p-3 rounded-lg bg-[#0d1117] border border-white/5">
                        <div className="text-[10px] text-muted-foreground mb-2">投注序列预览（输→升档，赢→降档）</div>
                        <div className="flex items-center gap-1 flex-wrap">
                          {cfg.amountLevels.map((amt, i) => (
                            <div key={i} className="flex items-center gap-1">
                              <div className={`px-2 py-1 rounded text-[10px] font-mono ${
                                i === cfg.startLevel
                                  ? 'bg-[#3b5de7] text-white'
                                  : i < cfg.startLevel
                                  ? 'bg-white/5 text-muted-foreground'
                                  : 'bg-[#f44336]/15 text-[#f44336]'
                              }`}>
                                ¥{amt >= 1000 ? `${amt / 1000}k` : amt}
                              </div>
                              {i < cfg.amountLevels.length - 1 && (
                                <span className="text-muted-foreground text-xs">→</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* ── OPTIONS TAB ── */}
                {tab === 'options' && (
                  <motion.div key="options" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="p-4 space-y-3">

                    {/* Play mode selector */}
                    <div className="flex bg-[#1e2538] rounded-xl p-1 gap-1">
                      {([
                        { id: 'normal' as PlayMode, label: '常规', desc: '自由选项' },
                        { id: 'double' as PlayMode, label: '双组', desc: '同押两项' },
                        { id: 'kill'   as PlayMode, label: '杀组', desc: '排一押三' },
                      ] as const).map(m => (
                        <button key={m.id} onClick={() => setCfg(p => ({ ...p, playMode: m.id }))}
                          className={`flex-1 py-2 rounded-lg transition-colors flex flex-col items-center gap-0.5 ${
                            cfg.playMode === m.id ? 'bg-[#3b5de7] text-white' : 'text-muted-foreground hover:text-white'
                          }`}
                        >
                          <span className="text-xs font-semibold">{m.label}</span>
                          <span className="text-[9px] opacity-70">{m.desc}</span>
                        </button>
                      ))}
                    </div>

                    {/* ── NORMAL MODE ── */}
                    {cfg.playMode === 'normal' && (
                      <div className="bg-[#1a2035] border border-white/8 rounded-xl p-4">
                        <div className="text-xs text-muted-foreground mb-3">选择机器人可以下注的方向（至少1个，可多选）</div>
                        <div className="grid grid-cols-2 gap-2">
                          {BET_OPTION_META.map(opt => {
                            const active = cfg.betOptions.includes(opt.id);
                            return (
                              <button key={opt.id} onClick={() => toggleBetOption(opt.id)}
                                className={`relative flex items-center gap-3 p-3 rounded-xl border transition-all ${active ? '' : 'bg-[#1e2538] border-white/5'}`}
                                style={active ? { background: opt.color + '15', borderColor: opt.color + '55', boxShadow: `0 0 0 1px ${opt.color}30` } : {}}
                              >
                                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0"
                                  style={{ background: opt.color + '22', color: opt.color }}>
                                  {opt.label}
                                </div>
                                <span className="text-xs font-medium" style={{ color: active ? opt.color : '#888' }}>{opt.label}</span>
                                {active && (
                                  <div className="absolute top-2 right-2 w-3.5 h-3.5 rounded-full flex items-center justify-center text-[9px] font-bold"
                                    style={{ background: opt.color, color: '#000' }}>✓</div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                        <div className="mt-2 text-[10px] text-muted-foreground text-center">已选 {cfg.betOptions.length} / {BET_OPTION_META.length} 个选项</div>
                      </div>
                    )}

                    {/* ── DOUBLE GROUP MODE ── */}
                    {cfg.playMode === 'double' && (
                      <div className="space-y-3">
                        <div className="bg-[#1a2035] border border-white/8 rounded-xl p-4">
                          <div className="text-xs text-white font-medium mb-1">双组投注</div>
                          <div className="text-[10px] text-muted-foreground mb-3">每期同时押注两个方向，分散风险</div>

                          {/* Quick pairs */}
                          <div className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wide">快捷组合</div>
                          <div className="grid grid-cols-2 gap-2 mb-4">
                            {QUICK_PAIRS.map(pair => {
                              const isActive = cfg.doubleGroupA === pair.a && cfg.doubleGroupB === pair.b;
                              const metaA = BET_OPTION_META.find(m => m.id === pair.a)!;
                              const metaB = BET_OPTION_META.find(m => m.id === pair.b)!;
                              return (
                                <button key={pair.label}
                                  onClick={() => setCfg(p => ({ ...p, doubleGroupA: pair.a, doubleGroupB: pair.b }))}
                                  className={`p-3 rounded-xl border text-left transition-all ${isActive ? 'bg-[#3b5de7]/20 border-[#3b5de7]/50' : 'bg-[#1e2538] border-white/5 hover:border-white/20'}`}
                                >
                                  <div className="flex items-center gap-1.5 mb-1">
                                    <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: metaA.color + '25', color: metaA.color }}>{metaA.label}</span>
                                    <span className="text-muted-foreground text-[10px]">+</span>
                                    <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: metaB.color + '25', color: metaB.color }}>{metaB.label}</span>
                                  </div>
                                  <div className="text-[10px] text-muted-foreground">{pair.label}</div>
                                </button>
                              );
                            })}
                          </div>

                          {/* Custom picker */}
                          <div className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wide">自定义组合（点选任意两项）</div>
                          <div className="grid grid-cols-4 gap-1.5">
                            {BET_OPTION_META.map(opt => {
                              const isA = cfg.doubleGroupA === opt.id;
                              const isB = cfg.doubleGroupB === opt.id;
                              const role = isA ? 'A' : isB ? 'B' : null;
                              return (
                                <button key={opt.id}
                                  onClick={() => {
                                    if (isA) return;
                                    if (isB) { setCfg(p => ({ ...p, doubleGroupB: p.doubleGroupA, doubleGroupA: opt.id })); return; }
                                    setCfg(p => ({ ...p, doubleGroupB: opt.id }));
                                  }}
                                  className={`relative py-2 rounded-lg border text-center text-xs font-bold transition-all ${role ? '' : 'bg-[#1e2538] border-white/5 hover:border-white/20 text-muted-foreground'}`}
                                  style={role ? { background: opt.color + '20', borderColor: opt.color + '60', color: opt.color } : {}}
                                >
                                  {opt.label}
                                  {role && (
                                    <div className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center text-black"
                                      style={{ background: opt.color }}>
                                      {role}
                                    </div>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* Preview */}
                        <div className="p-3 rounded-xl bg-[#1e2538] border border-white/8">
                          <div className="text-[10px] text-muted-foreground mb-2">当前双组配置 · 投注格式预览</div>
                          <div className="flex items-center gap-2">
                            {(() => {
                              const a = BET_OPTION_META.find(m => m.id === cfg.doubleGroupA)!;
                              const b = BET_OPTION_META.find(m => m.id === cfg.doubleGroupB)!;
                              return (
                                <>
                                  <span className="text-sm font-bold px-2 py-1 rounded-lg" style={{ background: a.color + '20', color: a.color }}>{a.label}</span>
                                  <span className="text-white font-bold">+</span>
                                  <span className="text-sm font-bold px-2 py-1 rounded-lg" style={{ background: b.color + '20', color: b.color }}>{b.label}</span>
                                  <span className="text-muted-foreground text-xs ml-1">→ 投注：{a.label}+{b.label}</span>
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ── KILL GROUP MODE ── */}
                    {cfg.playMode === 'kill' && (
                      <div className="space-y-3">
                        <div className="bg-[#1a2035] border border-white/8 rounded-xl p-4">
                          <div className="text-xs text-white font-medium mb-1">杀组投注</div>
                          <div className="text-[10px] text-muted-foreground mb-4">选择要杀掉的方向，机器人将押注其余三项</div>

                          {/* 4-quadrant kill selector */}
                          <div className="grid grid-cols-2 gap-2">
                            {QUADRANT_OPTIONS.map(optId => {
                              const opt = BET_OPTION_META.find(m => m.id === optId)!;
                              const isKilled = cfg.killOption === optId;
                              const isActive = !isKilled;
                              return (
                                <button key={optId}
                                  onClick={() => setCfg(p => ({ ...p, killOption: optId }))}
                                  className={`relative p-4 rounded-xl border text-center transition-all ${
                                    isKilled
                                      ? 'bg-[#f44336]/10 border-[#f44336]/50'
                                      : 'bg-[#10b981]/10 border-[#10b981]/30'
                                  }`}
                                >
                                  <div className="text-lg font-bold mb-1" style={{ color: isKilled ? '#f44336' : opt.color }}>
                                    {opt.label}
                                  </div>
                                  {isKilled ? (
                                    <div className="text-[10px] text-[#f44336] font-bold">✕ 已杀</div>
                                  ) : (
                                    <div className="text-[10px] text-[#10b981]">✓ 投注</div>
                                  )}
                                  {isKilled && (
                                    <div className="absolute inset-0 rounded-xl flex items-center justify-center pointer-events-none">
                                      <div className="w-full h-0.5 bg-[#f44336]/40 absolute" style={{ transform: 'rotate(-12deg)' }} />
                                    </div>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* Kill group preview */}
                        <div className="p-3 rounded-xl bg-[#1e2538] border border-white/8">
                          <div className="text-[10px] text-muted-foreground mb-2">杀组预览 · 实际下注方向</div>
                          <div className="flex flex-wrap gap-2 items-center">
                            {QUADRANT_OPTIONS.filter(o => o !== cfg.killOption).map(optId => {
                              const opt = BET_OPTION_META.find(m => m.id === optId)!;
                              return (
                                <span key={optId} className="text-sm font-bold px-2.5 py-1 rounded-lg"
                                  style={{ background: opt.color + '20', color: opt.color, border: `1px solid ${opt.color}40` }}>
                                  {opt.label}
                                </span>
                              );
                            })}
                            <span className="text-[10px] text-muted-foreground">
                              → 投注：{QUADRANT_OPTIONS.filter(o => o !== cfg.killOption).map(o => BET_OPTION_META.find(m => m.id === o)!.label).join('+')}
                            </span>
                          </div>
                          <div className="mt-2 text-[10px] text-[#c8a520]">
                            杀 <span className="font-bold text-[#f44336]">{BET_OPTION_META.find(m => m.id === cfg.killOption)?.label}</span>，共押注 3 项
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Bottom summary */}
                    <div className="p-3 rounded-xl bg-[#0d1117] border border-white/5">
                      <div className="text-[10px] text-muted-foreground mb-1.5">实际生效的投注方向</div>
                      <div className="flex flex-wrap gap-1.5">
                        {getEffectiveBetOptions(cfg).map(optId => {
                          const opt = BET_OPTION_META.find(m => m.id === optId)!;
                          return (
                            <span key={optId} className="text-xs font-medium px-2 py-0.5 rounded-full"
                              style={{ background: opt.color + '20', color: opt.color, border: `1px solid ${opt.color}40` }}>
                              {opt.label}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* ── ALGORITHM TAB ── */}
                {tab === 'algorithm' && (
                  <motion.div key="algorithm" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground uppercase tracking-wide">AI投注算法</span>
                      <div className="flex gap-2">
                        <button
                          onClick={selectAllAlgorithms}
                          className="text-[10px] px-2.5 py-1 rounded-lg bg-[#3b5de7]/20 text-[#4CA2FF] hover:bg-[#3b5de7]/30 transition-colors"
                        >
                          全选
                        </button>
                        <button
                          onClick={() => setCfg(p => ({ ...p, algorithms: [ALGORITHM_META[0].id] }))}
                          className="text-[10px] px-2.5 py-1 rounded-lg bg-white/5 text-muted-foreground hover:text-white transition-colors"
                        >
                          重置
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      {ALGORITHM_META.map(algo => {
                        const active = cfg.algorithms.includes(algo.id);
                        return (
                          <button
                            key={algo.id}
                            onClick={() => toggleAlgorithm(algo.id)}
                            className={`w-full flex items-start gap-3 p-3.5 rounded-xl border text-left transition-all ${
                              active
                                ? 'border-opacity-40 ring-1'
                                : 'bg-[#1a2035] border-white/8 hover:border-white/15'
                            }`}
                            style={active ? {
                              background: algo.color + '12',
                              borderColor: algo.color + '44',
                              boxShadow: `0 0 0 1px ${algo.color}22`,
                            } : {}}
                          >
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold flex-shrink-0"
                              style={{ background: algo.color + '25', color: algo.color }}>
                              <Cpu className="w-4 h-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-sm font-medium" style={{ color: active ? algo.color : '#ccc' }}>
                                  {algo.title}
                                </span>
                                {active && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold"
                                    style={{ background: algo.color + '30', color: algo.color }}>
                                    {algo.badge}
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-muted-foreground leading-relaxed">{algo.desc}</p>
                            </div>
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-all ${
                              active ? 'text-black' : 'border-white/15'
                            }`} style={active ? { background: algo.color, borderColor: algo.color } : {}}>
                              {active && <span className="text-[10px] font-bold">✓</span>}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {cfg.algorithms.length > 1 && (
                      <div className="p-3 rounded-xl bg-[#c8a520]/10 border border-[#c8a520]/25">
                        <div className="text-[10px] text-[#c8a520]">
                          ⚡ 已选{cfg.algorithms.length}个算法 — 系统将轮流使用各算法决策
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}

              </AnimatePresence>
            </div>

            {/* Save button */}
            <div className="px-4 pb-6 pt-3 border-t border-white/10 flex-shrink-0">
              <button
                onClick={handleSave}
                disabled={saving || cfg.betOptions.length === 0 || cfg.algorithms.length === 0}
                className={`w-full h-11 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all ${
                  saved
                    ? 'bg-[#00e676] text-black'
                    : 'bg-[#3b5de7] hover:bg-blue-600 text-white disabled:opacity-40'
                }`}
              >
                {saving ? (
                  <><Loader2 className="w-4 h-4 animate-spin" />保存中...</>
                ) : saved ? (
                  '✓ 配置已保存'
                ) : (
                  <><Save className="w-4 h-4" />保存投注配置</>
                )}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
