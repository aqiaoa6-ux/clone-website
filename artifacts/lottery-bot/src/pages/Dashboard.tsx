import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Menu, Moon, RefreshCw, Users, SlidersHorizontal } from 'lucide-react';
import SettingsDrawer from '@/components/SettingsDrawer';
import TelegramLoginModal from '@/components/TelegramLoginModal';
import GroupSetupModal from '@/components/GroupSetupModal';
import BetConfigModal, { type BetConfig } from '@/components/BetConfigModal';
import TrendModal from '@/components/TrendModal';
import type { LotteryTerm as TrendTerm } from '@/components/TrendModal';
import BetSetupPanel, { type BetSetupConfig } from '@/components/BetSetupPanel';

interface LotteryTerm {
  term: number;
  result: number;
  sum1: number;
  sum2: number;
  sum3: number;
  r1: string;
  r2: string;
  r3: string;
  openTime: number;
  closeTime: number;
}

interface MeInfo {
  id: number | bigint;
  firstName?: string;
  lastName?: string;
  username?: string;
  phone?: string;
}

interface GroupInfo {
  id: string;
  title: string;
  type: string;
}

function getSumColor(result: number): string {
  const blue = [0, 1, 3, 4, 9, 10, 14, 15, 20];
  const green = [6, 11, 16, 17, 21, 22];
  if (blue.includes(result)) return '#4CA2FF';
  if (green.includes(result)) return '#10b981';
  return '#f44336';
}

const mockRecords = [
  { period: 3433396, content: '27', result: '20', pnl: -5000.0, amount: 5000.0, status: '挂' },
  { period: 3433396, content: '单', result: '双', pnl: -800000.0, amount: 800000.0, status: '挂' },
  { period: 3433395, content: '27', result: '11', pnl: -5000.0, amount: 5000.0, status: '挂' },
  { period: 3433395, content: '双', result: '单', pnl: -400000.0, amount: 400000.0, status: '挂' },
  { period: 3433394, content: '27', result: '11', pnl: -5000.0, amount: 5000.0, status: '挂' },
  { period: 3433394, content: '双', result: '单', pnl: -200000.0, amount: 200000.0, status: '挂' },
  { period: 3433393, content: '27', result: '11', pnl: -5000.0, amount: 5000.0, status: '挂' },
  { period: 3433393, content: '双', result: '单', pnl: -39200.0, amount: 400000.0, status: '挂' },
];

export default function Dashboard() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [currentPeriod, setCurrentPeriod] = useState(0);
  const [latestTerm, setLatestTerm] = useState<LotteryTerm | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [tgMe, setTgMe] = useState<MeInfo | null>(null);
  const [watchGroup, setWatchGroup] = useState<GroupInfo | null>(null);
  const [betConfig, setBetConfig] = useState<Partial<BetConfig>>({ betAmount: 100, autoBet: false, strategy: 'normal' });
  const [trendOpen, setTrendOpen] = useState(false);
  const [betSetupOpen, setBetSetupOpen] = useState(false);
  const [betSetupConfig, setBetSetupConfig] = useState<Partial<BetSetupConfig>>({});
  const [allItems, setAllItems] = useState<TrendTerm[]>([]);
  const nextOpenTimeRef = useRef<number>(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLotteryData = useCallback(async () => {
    try {
      const res = await fetch('/api/lottery/fengpan');
      if (!res.ok) throw new Error('API error');
      const data = await res.json() as { message?: { all?: { keno28?: { data?: LotteryTerm[] } } } };
      const items: LotteryTerm[] = data?.message?.all?.keno28?.data ?? [];
      if (items.length > 0) {
        const latest = items[0];
        setLatestTerm(latest);
        setAllItems(items as TrendTerm[]);
        nextOpenTimeRef.current = latest.openTime + 210000;
        setCurrentPeriod(latest.term + 1);
        setFetchError(false);
        setLastFetched(new Date());
      }
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLotteryData();
    const poll = setInterval(fetchLotteryData, 210000);
    return () => clearInterval(poll);
  }, [fetchLotteryData]);

  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      const diff = Math.max(0, Math.floor((nextOpenTimeRef.current - Date.now()) / 1000));
      setCountdown(diff);
      if (diff === 0) setTimeout(fetchLotteryData, 3000);
    }, 1000);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [fetchLotteryData]);

  useEffect(() => {
    fetch('/api/tg/status')
      .then(r => r.json())
      .then((d: { connected?: boolean; me?: MeInfo; watchGroupId?: string; autoBet?: boolean; betAmount?: number; strategy?: BetConfig['strategy']; betMultiplier?: number; maxConsecutiveLosses?: number; stopLoss?: number; targetProfit?: number; cooldownSeconds?: number; betType?: BetConfig['betType'] }) => {
        if (d.connected && d.me) setTgMe(d.me);
        setBetConfig({
          autoBet: d.autoBet ?? false,
          betAmount: d.betAmount ?? 100,
          strategy: d.strategy ?? 'normal',
          betMultiplier: d.betMultiplier ?? 2,
          maxConsecutiveLosses: d.maxConsecutiveLosses ?? 5,
          stopLoss: d.stopLoss ?? 5000,
          targetProfit: d.targetProfit ?? 3000,
          cooldownSeconds: d.cooldownSeconds ?? 0,
          betType: d.betType ?? 'follow',
        });
        if (d.autoBet) setIsRunning(true);
      })
      .catch(() => { /* ignore */ });
  }, []);

  function handleConnected(me: MeInfo) {
    setTgMe(me);
    setLoginOpen(false);
    setTimeout(() => setGroupOpen(true), 400);
  }

  async function handleDisconnect() {
    await fetch('/api/tg/disconnect', { method: 'POST' });
    setTgMe(null);
    setWatchGroup(null);
    setIsRunning(false);
  }

  async function handleToggleRun() {
    const next = !isRunning;
    setIsRunning(next);
    if (tgMe) {
      await fetch('/api/tg/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...betConfig, autoBet: next }),
      }).catch(() => {});
      setBetConfig(prev => ({ ...prev, autoBet: next }));
    }
  }

  function handleSaveConfig(cfg: BetConfig) {
    setBetConfig(cfg);
    if (cfg.autoBet) setIsRunning(true);
  }

  const prevBalls = latestTerm ? [latestTerm.sum1, latestTerm.sum2, latestTerm.sum3] : [4, 3, 6];
  const prevResult = latestTerm?.result ?? 13;
  const prevLabel = latestTerm?.r3 ?? '小单';
  const prevTerm = latestTerm?.term ?? 0;

  return (
    <div className="min-h-screen bg-background text-foreground flex justify-center pb-8 relative">
      <div className="w-full max-w-[430px] bg-background shadow-2xl overflow-hidden flex flex-col relative">

        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-border/50">
          <Button variant="ghost" size="icon" onClick={() => setDrawerOpen(true)} className="text-muted-foreground hover:text-white" data-testid="button-open-drawer">
            <Menu className="w-6 h-6" />
          </Button>

          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              onClick={() => tgMe ? setGroupOpen(true) : setLoginOpen(true)}
              className={`${tgMe ? 'bg-green-600 hover:bg-green-700' : 'bg-[#3b5de7] hover:bg-blue-600'} text-white h-8 text-xs px-3`}
              data-testid="button-connect-tg"
            >
              {tgMe ? '已连接' : '连接TG'}
            </Button>
            <Button
              size="sm"
              className={`${isRunning ? 'bg-orange-500 hover:bg-orange-600' : 'bg-[#00e676] hover:bg-green-500'} text-black font-semibold h-8 text-xs px-3`}
              onClick={handleToggleRun}
              data-testid="button-start"
            >
              {isRunning ? '运行中' : '启动'}
            </Button>
            <Button size="sm" className="bg-[#f44336] hover:bg-red-600 text-white h-8 text-xs px-3" onClick={async () => {
              if (isRunning) {
                setIsRunning(false);
                if (tgMe) {
                  await fetch('/api/tg/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...betConfig, autoBet: false }) }).catch(() => {});
                  setBetConfig(prev => ({ ...prev, autoBet: false }));
                }
              }
            }} data-testid="button-stop">
              停止
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-white h-8 w-8 p-0"
              onClick={() => setConfigOpen(true)}
              data-testid="button-config"
              title="投注配置"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </Button>
          </div>

          <Button variant="ghost" size="icon" className="text-muted-foreground" data-testid="button-theme">
            <Moon className="w-5 h-5" />
          </Button>
        </div>

        {/* TG Connected bar */}
        {tgMe && (
          <div className="flex items-center justify-between px-3 py-1.5 bg-green-900/20 border-b border-green-800/30">
            <div className="flex items-center gap-2 text-xs text-green-400">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
              <span className="truncate max-w-[120px]">
                {tgMe.firstName}{tgMe.lastName ? ` ${tgMe.lastName}` : ''}
                {tgMe.username ? ` @${tgMe.username}` : ''}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setGroupOpen(true)}
                className="flex items-center gap-1 text-xs text-[#4CA2FF] hover:text-blue-400 transition-colors"
                data-testid="button-set-group"
              >
                <Users className="w-3 h-3" />
                <span className="truncate max-w-[90px]">{watchGroup ? watchGroup.title : '设置投注群'}</span>
              </button>
              <button
                onClick={() => setConfigOpen(true)}
                className="flex items-center gap-1 text-xs text-[#c8a520] hover:text-yellow-400 transition-colors"
                data-testid="button-open-config"
              >
                <SlidersHorizontal className="w-3 h-3" />
                <span>
                  {betConfig.strategy === 'martingale' ? '马丁' : betConfig.strategy === 'anti-martingale' ? '反马丁' : '普通'}
                  {' '}¥{betConfig.betAmount ?? 100}
                </span>
              </button>
            </div>
          </div>
        )}

        <div className="p-4 flex-1 overflow-y-auto pb-10">

          {/* Period Info */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2 text-lg">
              {loading ? (
                <span className="text-muted-foreground text-sm">加载开奖数据...</span>
              ) : fetchError ? (
                <span className="text-[#f44336] text-sm flex items-center gap-2">
                  数据获取失败
                  <button onClick={fetchLotteryData} className="text-xs underline text-muted-foreground">重试</button>
                </span>
              ) : (
                <>
                  <span className="text-[#3b5de7] font-medium" data-testid="text-current-period">{currentPeriod}期:</span>
                  <span className="text-[#c8a520] font-bold" data-testid="text-countdown">{countdown}秒</span>
                  <button onClick={fetchLotteryData} className="ml-1 text-muted-foreground hover:text-white transition-colors" title={lastFetched ? `上次更新: ${lastFetched.toLocaleTimeString()}` : ''} data-testid="button-refresh">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>

            {!loading && !fetchError && (
              <div className="flex items-center gap-1.5 text-sm">
                <span className="text-muted-foreground">上期:</span>
                <span className="text-muted-foreground text-xs ml-0.5">{prevTerm}</span>
                <div className="flex items-center gap-1 ml-1">
                  {prevBalls.map((b, i) => (
                    <span key={i} className="flex items-center gap-0.5">
                      <span className="w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs" style={{ backgroundColor: '#3b5de733', border: '1px solid #3b5de766', color: '#4CA2FF' }} data-testid={`text-ball-${i}`}>{b}</span>
                      {i < 2 && <span className="text-muted-foreground text-xs">+</span>}
                    </span>
                  ))}
                  <span className="text-muted-foreground text-xs">=</span>
                  <span className="w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs" style={{ backgroundColor: getSumColor(prevResult) + '33', border: `1px solid ${getSumColor(prevResult)}66`, color: getSumColor(prevResult) }} data-testid="text-result">{prevResult}</span>
                </div>
                <span className="text-muted-foreground text-xs ml-1">({prevLabel})</span>
              </div>
            )}
          </div>

          {/* Balance */}
          <div className="bg-card border border-border rounded-lg p-4 mb-4">
            <div className="text-muted-foreground text-sm mb-1">当前余额:</div>
            <div className="text-[#00e676] text-3xl font-bold font-mono tracking-tight" data-testid="text-balance">1198306.57</div>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-card border border-border rounded-lg p-3">
              <div className="text-muted-foreground text-xs mb-1">今日盈亏</div>
              <div className="text-[#00e676] font-bold">+0.00</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-3">
              <div className="text-muted-foreground text-xs mb-1">总盈亏</div>
              <div className="text-[#f44336] font-bold">-919000.00</div>
            </div>
          </div>

          {/* Stats Row */}
          <div className="bg-card border border-border rounded-lg p-3 grid grid-cols-4 gap-2 mb-6 divide-x divide-border">
            {[['总投注', '17次'], ['中奖', '8次'], ['最大连中', '4'], ['胜率', '47.06%']].map(([label, val]) => (
              <div key={label} className="text-center">
                <div className="text-muted-foreground text-[10px] mb-1">{label}</div>
                <div className="text-sm font-medium">{val}</div>
              </div>
            ))}
          </div>

          {/* Betting Records */}
          <div>
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-sm font-medium flex items-center gap-1.5"><span>📋</span> 投注记录</h3>
              <div className="flex gap-2">
                <Button size="sm" className="bg-[#2d3654] hover:bg-[#3d4664] text-white h-7 text-xs px-2">期号搜索</Button>
                <Button size="sm" className="bg-[#2d3654] hover:bg-[#3d4664] text-white h-7 text-xs px-2">重置</Button>
                <Button size="sm" className="bg-transparent border border-[#f44336] text-[#f44336] hover:bg-[#f44336]/10 h-7 text-xs px-2">🚫 清空投注</Button>
              </div>
            </div>
            <div className="rounded-md border border-border overflow-hidden text-xs">
              <table className="w-full text-center">
                <thead className="bg-[#2d3654]/50 border-b border-border">
                  <tr>
                    {['期号', '投注内容', '开奖', '盈亏', '金额', '状态'].map(h => (
                      <th key={h} className="py-2 px-1 font-normal text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {mockRecords.map((record, i) => (
                    <tr key={i} className="hover:bg-muted/50" data-testid={`row-record-${i}`}>
                      <td className="py-2.5 px-1">{record.period}</td>
                      <td className="py-2.5 px-1">{record.content}</td>
                      <td className="py-2.5 px-1">{record.result}</td>
                      <td className="py-2.5 px-1 text-[#f44336]">{record.pnl.toFixed(2)}</td>
                      <td className="py-2.5 px-1 text-muted-foreground">{record.amount.toFixed(2)}</td>
                      <td className="py-2.5 px-1 text-[#f44336]">{record.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="absolute bottom-0 left-0 w-full bg-[#1a1f2e] border-t border-border p-2 text-[10px] text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis px-4 z-10">
          {latestTerm ? (
            <><span className="text-white/70">{latestTerm.term}期:</span> {latestTerm.sum1}+{latestTerm.sum2}+{latestTerm.sum3}={latestTerm.result} <span className="text-[#4CA2FF]">{latestTerm.r3}</span></>
          ) : <span className="text-white/70">加载中...</span>}
          {' '}单金额 <span className="text-[#f44336]">-39200</span> 金额 <span className="text-white/60">400000</span>
        </div>

        <SettingsDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          tgMe={tgMe}
          watchGroup={watchGroup}
          onConnectTg={() => { setDrawerOpen(false); setTimeout(() => setLoginOpen(true), 200); }}
          onSetGroup={() => { setDrawerOpen(false); setTimeout(() => setGroupOpen(true), 200); }}
          onDisconnect={handleDisconnect}
          onOpenConfig={() => { setDrawerOpen(false); setTimeout(() => setConfigOpen(true), 200); }}
          onOpenTrend={() => { setDrawerOpen(false); setTimeout(() => setTrendOpen(true), 200); }}
          onOpenBetSetup={() => { setDrawerOpen(false); setTimeout(() => setBetSetupOpen(true), 200); }}
        />
        <TelegramLoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} onConnected={handleConnected} />
        <GroupSetupModal isOpen={groupOpen} onClose={() => setGroupOpen(false)} onGroupSet={setWatchGroup} currentGroupId={watchGroup?.id} />
        <BetConfigModal
          isOpen={configOpen}
          onClose={() => setConfigOpen(false)}
          onSave={handleSaveConfig}
          initialConfig={betConfig}
        />
        <TrendModal
          isOpen={trendOpen}
          onClose={() => setTrendOpen(false)}
          initialItems={allItems}
        />
        <BetSetupPanel
          isOpen={betSetupOpen}
          onClose={() => setBetSetupOpen(false)}
          onSave={(cfg) => {
            setBetSetupConfig(cfg);
            if (cfg.groupId && cfg.groupTitle) {
              setWatchGroup({ id: cfg.groupId, title: cfg.groupTitle, type: 'group' });
            }
          }}
          initialConfig={betSetupConfig}
          tgConnected={!!tgMe}
          currentGroupId={watchGroup?.id}
        />
      </div>
    </div>
  );
}
