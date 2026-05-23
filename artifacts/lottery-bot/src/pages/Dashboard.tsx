import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Menu, Moon, RefreshCw, Users, SlidersHorizontal } from 'lucide-react';
import SettingsDrawer from '@/components/SettingsDrawer';
import TelegramLoginModal from '@/components/TelegramLoginModal';
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

interface BetRecord {
  id: string;
  betContent: string;
  amount: number;
  timestamp: number;
  status: 'sent' | 'failed' | 'paused' | 'won' | 'lost';
  pauseReason?: string;
  period?: number;
  lotteryResult?: string;
  pnl?: number;
  won?: boolean;
}

const STATUS_LABEL: Record<string, string> = { sent: '待开奖', won: '中奖', lost: '挂逼', paused: '停', failed: '失败' };
const STATUS_COLOR: Record<string, string> = { sent: '#c8a520', won: '#00e676', lost: '#f44336', paused: '#888', failed: '#555' };

function getSumColor(result: number): string {
  const blue = [0, 1, 3, 4, 9, 10, 14, 15, 20];
  const green = [6, 11, 16, 17, 21, 22];
  if (blue.includes(result)) return '#4CA2FF';
  if (green.includes(result)) return '#10b981';
  return '#f44336';
}

export default function Dashboard() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
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
  // live data
  const [records, setRecords] = useState<BetRecord[]>([]);
  const [balance, setBalance] = useState(1000000);
  const [todayPnl, setTodayPnl] = useState(0);
  const [totalPnl, setTotalPnl] = useState(0);
  const [totalBets, setTotalBets] = useState(0);
  const [wins, setWins] = useState(0);
  const [maxStreak, setMaxStreak] = useState(0);
  const [winRate, setWinRate] = useState('0.00');
  const [consecutiveLosses, setConsecutiveLosses] = useState(0);
  const [currentBetAmt, setCurrentBetAmt] = useState(100);
  const [lastDraw, setLastDraw] = useState<{ term: number; r3: string; sum1?: number; sum2?: number; sum3?: number; result?: number } | null>(null);
  const [nextBetAt, setNextBetAt] = useState<number | null>(null); // unix-ms when next bet fires
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [searchPeriod, setSearchPeriod] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [balanceSource, setBalanceSource] = useState<'manual' | 'kkpay'>('manual');
  const [balanceUpdatedAt, setBalanceUpdatedAt] = useState(0);
  const [kkpayLinked, setKkpayLinked] = useState(false);
  const [kkpayUsername, setKkpayUsername] = useState('kkpay');
  const [showKkpayInput, setShowKkpayInput] = useState(false);
  const [kkpayInput, setKkpayInput] = useState('');
  const [sseConnected, setSseConnected] = useState(true);
  const [riskBlockReason, setRiskBlockReason] = useState<string | null>(null);
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
      const now = Date.now();
      setNowMs(now);
      const diff = Math.max(0, Math.floor((nextOpenTimeRef.current - now) / 1000));
      setCountdown(diff);
      if (diff === 0) setTimeout(fetchLotteryData, 3000);
    }, 1000);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [fetchLotteryData]);

  const fetchBetsAndStats = useCallback(async () => {
    try {
      const [betsRes, statusRes] = await Promise.all([
        fetch('/api/tg/bets'),
        fetch('/api/tg/status'),
      ]);
      if (betsRes.ok) {
        const d = await betsRes.json() as { bets?: BetRecord[] };
        setRecords(d.bets ?? []);
      }
      if (statusRes.ok) {
        const sd = await statusRes.json() as {
          connected?: boolean; me?: MeInfo; watchGroupId?: string; watchGroupTitle?: string;
          autoBet?: boolean; betAmount?: number; strategy?: BetConfig['strategy'];
          betMultiplier?: number; maxConsecutiveLosses?: number; stopLoss?: number;
          targetProfit?: number; cooldownSeconds?: number; betType?: BetConfig['betType'];
          balance?: number; todayPnl?: number; sessionPnl?: number;
          totalBets?: number; wins?: number; maxStreak?: number; winRate?: string;
          balanceSource?: 'manual' | 'kkpay'; balanceUpdatedAt?: number;
          kkpayUsername?: string; kkpayEntityId?: string;
          riskBlocked?: boolean; riskReason?: string;
          algorithms?: string[]; betOptions?: string[]; amountLevels?: number[];
          stepBackOnWin?: boolean;
          consecutiveLosses?: number; currentBet?: number;
        };
        if (sd.connected && sd.me) setTgMe(sd.me);
        // Restore the watch group so user doesn't need to re-enter it after reconnect
        if (sd.watchGroupId) {
          const title = sd.watchGroupTitle ?? sd.watchGroupId;
          setWatchGroup({ id: sd.watchGroupId, title, type: 'group' });
          setBetSetupConfig(prev => ({ ...prev, groupId: sd.watchGroupId, groupTitle: title }));
        }
        setBetConfig({
          autoBet: sd.autoBet ?? false,
          betAmount: sd.betAmount ?? 100,
          strategy: sd.strategy ?? 'normal',
          betMultiplier: sd.betMultiplier ?? 2,
          maxConsecutiveLosses: sd.maxConsecutiveLosses ?? 5,
          stopLoss: sd.stopLoss ?? 5000,
          targetProfit: sd.targetProfit ?? 3000,
          cooldownSeconds: sd.cooldownSeconds ?? 0,
          betType: sd.betType ?? 'follow',
        });
        setRiskBlockReason(sd.riskBlocked && sd.riskReason ? sd.riskReason : null);
        if (sd.autoBet) setIsRunning(true);
        if (sd.balance !== undefined) setBalance(sd.balance);
        if (sd.todayPnl !== undefined) setTodayPnl(sd.todayPnl);
        if (sd.sessionPnl !== undefined) setTotalPnl(sd.sessionPnl);
        if (sd.totalBets !== undefined) setTotalBets(sd.totalBets);
        if (sd.wins !== undefined) setWins(sd.wins);
        if (sd.maxStreak !== undefined) setMaxStreak(sd.maxStreak);
        if (sd.winRate !== undefined) setWinRate(sd.winRate);
        if (sd.consecutiveLosses !== undefined) setConsecutiveLosses(sd.consecutiveLosses);
        if (sd.currentBet !== undefined) setCurrentBetAmt(sd.currentBet);
        if (sd.balanceSource) setBalanceSource(sd.balanceSource);
        if (sd.balanceUpdatedAt !== undefined) setBalanceUpdatedAt(sd.balanceUpdatedAt);
        if (sd.kkpayUsername) setKkpayUsername(sd.kkpayUsername);
        setKkpayLinked(!!sd.kkpayEntityId);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchBetsAndStats();
    const poll = setInterval(fetchBetsAndStats, 5000);

    // SSE real-time updates with auto-reconnect
    let es: EventSource | null = null;
    let retryMs = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const handleMessage = (e: MessageEvent<string>) => {
      setSseConnected(true);
      retryMs = 1000;
      try {
        const ev = JSON.parse(e.data) as {
          type: string;
          bet?: BetRecord;
          balance?: number;
          balanceSource?: 'manual' | 'kkpay';
          balanceUpdatedAt?: number;
          todayPnl?: number;
          sessionPnl?: number;
          totalBets?: number;
          settled?: number;
          wins?: number;
          maxStreak?: number;
          winRate?: string;
          consecutiveLosses?: number;
          currentBet?: number;
          // draw:new fields
          term?: number;
          r3?: string;
          sum1?: number;
          sum2?: number;
          sum3?: number;
          result?: number;
          // timer:scheduled fields
          fireAt?: number;
          delaySec?: number;
        };
        if (ev.type === 'bet:new' && ev.bet) {
          setRecords(prev => {
            const exists = prev.some(r => r.id === ev.bet!.id);
            return exists ? prev : [ev.bet!, ...prev.slice(0, 49)];
          });
          if (ev.balance !== undefined) setBalance(ev.balance);
        } else if (ev.type === 'bet:result' && ev.bet) {
          setRecords(prev => prev.map(r => r.id === ev.bet!.id ? ev.bet! : r));
          if (ev.balance !== undefined) setBalance(ev.balance);
          if (ev.todayPnl !== undefined) setTodayPnl(ev.todayPnl);
          if (ev.sessionPnl !== undefined) setTotalPnl(ev.sessionPnl);
          if (ev.totalBets !== undefined) setTotalBets(ev.totalBets);
          if (ev.wins !== undefined) setWins(ev.wins);
          if (ev.maxStreak !== undefined) setMaxStreak(ev.maxStreak);
          if (ev.winRate !== undefined) setWinRate(ev.winRate);
          if (ev.consecutiveLosses !== undefined) setConsecutiveLosses(ev.consecutiveLosses);
          if (ev.currentBet !== undefined) setCurrentBetAmt(ev.currentBet);
        } else if (ev.type === 'draw:new') {
          if (ev.term) {
            setLastDraw({
              term: ev.term as number,
              r3: (ev.r3 as string) ?? '',
              sum1: ev.sum1 as number | undefined,
              sum2: ev.sum2 as number | undefined,
              sum3: ev.sum3 as number | undefined,
              result: ev.result as number | undefined,
            });
          }
        } else if (ev.type === 'timer:scheduled') {
          if (ev.fireAt !== undefined) setNextBetAt(ev.fireAt);
        } else if (ev.type === 'balance:update') {
          if (ev.balance !== undefined) setBalance(ev.balance);
          if (ev.balanceSource) setBalanceSource(ev.balanceSource);
          if (ev.balanceUpdatedAt !== undefined) setBalanceUpdatedAt(ev.balanceUpdatedAt);
        } else if (ev.type === 'session:reconnected') {
          fetchBetsAndStats();
        }
      } catch { /* ignore */ }
    };

    const connect = () => {
      if (destroyed) return;
      es = new EventSource('/api/tg/events');
      es.onmessage = handleMessage;
      es.onerror = () => {
        setSseConnected(false);
        es?.close();
        es = null;
        if (!destroyed) {
          retryTimer = setTimeout(() => {
            retryMs = Math.min(retryMs * 2, 30000);
            connect();
          }, retryMs);
        }
      };
      es.onopen = () => { setSseConnected(true); retryMs = 1000; };
    };
    connect();

    return () => {
      destroyed = true;
      clearInterval(poll);
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [fetchBetsAndStats]);

  function handleConnected(me: MeInfo) {
    setTgMe(me);
    setLoginOpen(false);
    setTimeout(() => setBetSetupOpen(true), 400);
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
    if (!tgMe) return;

    if (next) setRiskBlockReason(null);

    // When starting: ensure the watch group is set — use betSetupConfig or fall back to watchGroup
    const groupIdToSet = betSetupConfig.groupId ?? watchGroup?.id;
    if (next && groupIdToSet) {
      await fetch('/api/tg/set-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: groupIdToSet }),
      }).catch(() => {});
    }

    const body: Record<string, unknown> = { autoBet: next };
    if (next && betSetupConfig.algorithms) {
      body.algorithms    = betSetupConfig.algorithms;
      body.betOptions    = betSetupConfig.betOptions ?? ['big', 'small'];
      body.amountLevels  = betSetupConfig.amountLevels;
      body.stepBackOnWin = betSetupConfig.stepBackOnWin;
      body.startLevel    = betSetupConfig.startLevel;
    }
    await fetch('/api/tg/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
    setBetConfig(prev => ({ ...prev, autoBet: next }));
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
            {!sseConnected && (
              <span className="flex items-center gap-1 text-[10px] text-yellow-400 animate-pulse">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 inline-block" />
                重连中
              </span>
            )}
            <Button
              size="sm"
              onClick={() => tgMe ? setBetSetupOpen(true) : setLoginOpen(true)}
              className={`${tgMe ? 'bg-green-600 hover:bg-green-700' : 'bg-[#3b5de7] hover:bg-blue-600'} text-white h-8 text-xs px-3`}
              data-testid="button-connect-tg"
            >
              {tgMe ? '已连接' : '连接TG'}
            </Button>
            <Button
              size="sm"
              className={`${isRunning ? 'bg-[#f44336] hover:bg-red-600 text-white' : 'bg-[#00e676] hover:bg-green-500 text-black'} font-semibold h-8 text-xs px-3`}
              onClick={handleToggleRun}
              data-testid="button-start"
            >
              {isRunning ? '暂停' : '启动'}
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

        {/* Risk blocked warning */}
        {riskBlockReason && (
          <div className="flex items-center justify-between px-3 py-1.5 bg-red-900/30 border-b border-red-700/40">
            <span className="text-xs text-red-400 flex-1">⚠️ 风控暂停：{riskBlockReason}</span>
            <button onClick={() => setRiskBlockReason(null)} className="text-xs text-red-400/60 hover:text-red-300 ml-2">✕</button>
          </div>
        )}

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
                onClick={() => setBetSetupOpen(true)}
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
            <div className="flex items-center justify-between mb-1">
              <span className="text-muted-foreground text-sm">当前余额:</span>
              <div className="flex items-center gap-2">
                {balanceSource === 'kkpay' ? (
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-[10px] text-green-400 font-medium">@{kkpayUsername} 实时</span>
                    {balanceUpdatedAt > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(balanceUpdatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    )}
                  </div>
                ) : (
                  <button
                    className="text-[10px] text-[#4CA2FF] hover:text-blue-400 transition-colors"
                    onClick={() => { setShowKkpayInput(v => !v); setKkpayInput(kkpayUsername); }}
                  >
                    {kkpayLinked ? `@${kkpayUsername} 未连接` : '+ 接入kkpay'}
                  </button>
                )}
                {balanceSource === 'kkpay' && (
                  <button
                    className="text-[10px] text-muted-foreground hover:text-[#00e676] transition-colors"
                    title="立即查询余额"
                    onClick={async () => {
                      await fetch('/api/tg/kkpay/refresh', { method: 'POST' });
                      setTimeout(fetchBetsAndStats, 2500);
                    }}
                  >↻</button>
                )}
                <button
                  className="text-[10px] text-muted-foreground hover:text-white transition-colors"
                  onClick={() => { setShowKkpayInput(v => !v); setKkpayInput(kkpayUsername); }}
                  title="配置kkpay钱包"
                >⚙</button>
              </div>
            </div>
            {showKkpayInput && (
              <div className="flex gap-2 mb-2">
                <input
                  value={kkpayInput}
                  onChange={e => setKkpayInput(e.target.value)}
                  placeholder="输入机器人用户名，如 kkpay"
                  className="flex-1 bg-[#2d3654] border border-border rounded px-2 py-1 text-xs text-white placeholder-muted-foreground outline-none focus:border-[#3b5de7]"
                  onKeyDown={async e => {
                    if (e.key === 'Enter') {
                      await fetch('/api/tg/kkpay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: kkpayInput }) });
                      setKkpayUsername(kkpayInput.replace(/^@/, ''));
                      setShowKkpayInput(false);
                      setTimeout(fetchBetsAndStats, 2000);
                    }
                  }}
                />
                <button
                  className="bg-[#3b5de7] hover:bg-blue-600 text-white text-xs px-3 py-1 rounded transition-colors"
                  onClick={async () => {
                    await fetch('/api/tg/kkpay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: kkpayInput }) });
                    setKkpayUsername(kkpayInput.replace(/^@/, ''));
                    setShowKkpayInput(false);
                    setTimeout(fetchBetsAndStats, 2000);
                  }}
                >绑定</button>
              </div>
            )}
            <div className="text-[#00e676] text-3xl font-bold font-mono tracking-tight" data-testid="text-balance">
              {balance.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-card border border-border rounded-lg p-3">
              <div className="text-muted-foreground text-xs mb-1">今日盈亏</div>
              <div className={`font-bold ${todayPnl >= 0 ? 'text-[#00e676]' : 'text-[#f44336]'}`}>
                {todayPnl >= 0 ? '+' : ''}{todayPnl.toFixed(2)}
              </div>
            </div>
            <div className="bg-card border border-border rounded-lg p-3">
              <div className="text-muted-foreground text-xs mb-1">总盈亏</div>
              <div className={`font-bold ${totalPnl >= 0 ? 'text-[#00e676]' : 'text-[#f44336]'}`}>
                {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Stats Row */}
          <div className="bg-card border border-border rounded-lg mb-6 overflow-hidden">
            <div className="grid grid-cols-3 divide-x divide-border border-b border-border">
              {([
                ['总投注', `${totalBets}次`, null],
                ['中奖', `${wins}次`, wins > 0 ? '#00e676' : null],
                ['胜率', `${winRate}%`, parseFloat(winRate) >= 50 ? '#00e676' : '#f44336'],
              ] as [string, string, string | null][]).map(([label, val, color]) => (
                <div key={label} className="text-center py-2.5 px-1">
                  <div className="text-muted-foreground text-[10px] mb-1">{label}</div>
                  <div className="text-sm font-semibold" style={color ? { color } : undefined}>{val}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 divide-x divide-border">
              <div className="text-center py-2.5 px-1">
                <div className="text-muted-foreground text-[10px] mb-1">最大连中</div>
                <div className="text-sm font-semibold" style={maxStreak >= 3 ? { color: '#00e676' } : undefined}>{maxStreak}</div>
              </div>
              <div className="text-center py-2.5 px-1">
                <div className="text-muted-foreground text-[10px] mb-1">当前连亏</div>
                <div className="text-sm font-semibold" style={consecutiveLosses >= 2 ? { color: '#f44336' } : undefined}>
                  {consecutiveLosses > 0 ? `${consecutiveLosses}局` : '-'}
                </div>
              </div>
              <div className="text-center py-2.5 px-1">
                <div className="text-muted-foreground text-[10px] mb-1">
                  {nextBetAt && nextBetAt > nowMs ? '下次投注' : '当前注额'}
                </div>
                <div className="text-sm font-semibold text-[#c8a520]">
                  {nextBetAt && nextBetAt > nowMs
                    ? `${Math.ceil((nextBetAt - nowMs) / 1000)}s`
                    : currentBetAmt.toFixed(0)}
                </div>
              </div>
            </div>
          </div>

          {/* Betting Records */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-sm font-medium flex items-center gap-1.5"><span>📋</span> 投注记录</h3>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  className="bg-[#2d3654] hover:bg-[#3d4664] text-white h-7 text-xs px-2"
                  onClick={() => setShowSearch(s => !s)}
                >期号搜索</Button>
                <Button
                  size="sm"
                  className="bg-[#2d3654] hover:bg-[#3d4664] text-white h-7 text-xs px-2"
                  onClick={() => { setSearchPeriod(''); setShowSearch(false); }}
                >重置</Button>
                <Button
                  size="sm"
                  className="bg-transparent border border-[#f44336] text-[#f44336] hover:bg-[#f44336]/10 h-7 text-xs px-2"
                  onClick={async () => {
                    await fetch('/api/tg/bets', { method: 'DELETE' });
                    setRecords([]);
                  }}
                >🚫 清空投注</Button>
              </div>
            </div>
            {showSearch && (
              <div className="mb-2">
                <input
                  value={searchPeriod}
                  onChange={e => setSearchPeriod(e.target.value)}
                  placeholder="输入期号筛选..."
                  className="w-full bg-[#2d3654] border border-border rounded px-3 py-1.5 text-xs text-white placeholder-muted-foreground outline-none focus:border-[#3b5de7]"
                />
              </div>
            )}
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
                  {records
                    .filter(r => !searchPeriod || String(r.period ?? '').includes(searchPeriod))
                    .map((record, i) => {
                      const statusLabel = STATUS_LABEL[record.status] ?? record.status;
                      const statusColor = STATUS_COLOR[record.status] ?? '#888';
                      const pnl = record.pnl;
                      return (
                        <tr key={record.id ?? i} className="hover:bg-muted/50" data-testid={`row-record-${i}`}>
                          <td className="py-2.5 px-1">{record.period ?? '-'}</td>
                          <td className="py-2.5 px-1">{record.betContent}</td>
                          <td className="py-2.5 px-1">{record.lotteryResult ?? '-'}</td>
                          <td className={`py-2.5 px-1 ${pnl !== undefined ? (pnl >= 0 ? 'text-[#00e676]' : 'text-[#f44336]') : 'text-muted-foreground'}`}>
                            {pnl !== undefined ? (pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2)) : '-'}
                          </td>
                          <td className="py-2.5 px-1 text-muted-foreground">{record.amount.toFixed(2)}</td>
                          <td className="py-2.5 px-1 font-medium" style={{ color: statusColor }}>{statusLabel}</td>
                        </tr>
                      );
                    })}
                  {records.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-muted-foreground">暂无投注记录</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Bottom bar — shows the latest confirmed draw (SSE draw:new or initial poll) */}
        <div className="absolute bottom-0 left-0 w-full bg-[#1a1f2e] border-t border-border p-2 text-[10px] text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis px-4 z-10">
          {(() => {
            const d = lastDraw ?? (latestTerm ? { term: latestTerm.term, r3: latestTerm.r3, sum1: latestTerm.sum1, sum2: latestTerm.sum2, sum3: latestTerm.sum3, result: latestTerm.result } : null);
            if (!d) return <span className="text-white/70">加载中...</span>;
            return (
              <>
                <span className="text-white/70">{d.term}期:</span>
                {d.sum1 !== undefined ? ` ${d.sum1}+${d.sum2}+${d.sum3}=${d.result} ` : ' '}
                <span className="text-[#4CA2FF]">{d.r3}</span>
                <span className="ml-2 text-white/40">已开奖</span>
              </>
            );
          })()}
        </div>

        <SettingsDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          tgMe={tgMe}
          watchGroup={watchGroup}
          onConnectTg={() => { setDrawerOpen(false); setTimeout(() => setLoginOpen(true), 200); }}
          onSetGroup={() => { setDrawerOpen(false); setTimeout(() => setBetSetupOpen(true), 200); }}
          onDisconnect={handleDisconnect}
          onOpenConfig={() => { setDrawerOpen(false); setTimeout(() => setConfigOpen(true), 200); }}
          onOpenTrend={() => { setDrawerOpen(false); setTimeout(() => setTrendOpen(true), 200); }}
          onOpenBetSetup={() => { setDrawerOpen(false); setTimeout(() => setBetSetupOpen(true), 200); }}
        />
        <TelegramLoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} onConnected={handleConnected} />
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
