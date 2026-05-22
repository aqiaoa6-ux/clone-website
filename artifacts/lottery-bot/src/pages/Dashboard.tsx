import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Menu, Moon, RefreshCw } from 'lucide-react';
import SettingsDrawer from '@/components/SettingsDrawer';

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
  const [countdown, setCountdown] = useState(0);
  const [currentPeriod, setCurrentPeriod] = useState(0);
  const [latestTerm, setLatestTerm] = useState<LotteryTerm | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const nextOpenTimeRef = useRef<number>(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLotteryData = useCallback(async () => {
    try {
      const res = await fetch('/api/lottery/fengpan');
      if (!res.ok) throw new Error('API error');
      const data = await res.json();
      const items: LotteryTerm[] = data?.message?.all?.keno28?.data ?? [];
      if (items.length > 0) {
        const latest = items[0];
        setLatestTerm(latest);
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
      if (diff === 0) {
        setTimeout(fetchLotteryData, 3000);
      }
    }, 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [fetchLotteryData]);

  const prevBalls = latestTerm
    ? [latestTerm.sum1, latestTerm.sum2, latestTerm.sum3]
    : [4, 3, 6];
  const prevResult = latestTerm?.result ?? 13;
  const prevLabel = latestTerm?.r3 ?? '小单';
  const prevTerm = latestTerm?.term ?? 0;

  return (
    <div className="min-h-screen bg-background text-foreground flex justify-center pb-8 relative">
      <div className="w-full max-w-[430px] bg-background shadow-2xl overflow-hidden flex flex-col relative">

        {/* Top Header */}
        <div className="flex items-center justify-between p-3 border-b border-border/50">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDrawerOpen(true)}
            className="text-muted-foreground hover:text-white"
            data-testid="button-open-drawer"
          >
            <Menu className="w-6 h-6" />
          </Button>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="bg-[#3b5de7] hover:bg-blue-600 text-white h-8 text-xs px-3"
              data-testid="button-connect-tg"
            >
              连接TG
            </Button>
            <Button
              size="sm"
              className={`${isRunning ? 'bg-orange-600 hover:bg-orange-700' : 'bg-[#00e676] hover:bg-green-600'} text-white h-8 text-xs px-4`}
              onClick={() => setIsRunning(!isRunning)}
              data-testid="button-start-stop"
            >
              {isRunning ? '运行中' : '启动'}
            </Button>
            <Button
              size="sm"
              className="bg-[#f44336] hover:bg-red-600 text-white h-8 text-xs px-4"
              onClick={() => setIsRunning(false)}
              data-testid="button-stop"
            >
              停止
            </Button>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            data-testid="button-theme"
          >
            <Moon className="w-5 h-5" />
          </Button>
        </div>

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
                  <span className="text-[#3b5de7] font-medium" data-testid="text-current-period">
                    {currentPeriod}期:
                  </span>
                  <span className="text-[#c8a520] font-bold" data-testid="text-countdown">
                    {countdown}秒
                  </span>
                  <button
                    onClick={fetchLotteryData}
                    className="ml-1 text-muted-foreground hover:text-white transition-colors"
                    title={lastFetched ? `上次更新: ${lastFetched.toLocaleTimeString()}` : ''}
                    data-testid="button-refresh"
                  >
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
                      <span
                        className="w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs"
                        style={{ backgroundColor: '#3b5de7' + '33', border: '1px solid #3b5de766', color: '#4CA2FF' }}
                        data-testid={`text-ball-${i}`}
                      >
                        {b}
                      </span>
                      {i < 2 && <span className="text-muted-foreground text-xs">+</span>}
                    </span>
                  ))}
                  <span className="text-muted-foreground text-xs">=</span>
                  <span
                    className="w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs"
                    style={{
                      backgroundColor: getSumColor(prevResult) + '33',
                      border: `1px solid ${getSumColor(prevResult)}66`,
                      color: getSumColor(prevResult),
                    }}
                    data-testid="text-result"
                  >
                    {prevResult}
                  </span>
                </div>
                <span className="text-muted-foreground text-xs ml-1">({prevLabel})</span>
              </div>
            )}
          </div>

          {/* Balance Display */}
          <div className="bg-card border border-border rounded-lg p-4 mb-4">
            <div className="text-muted-foreground text-sm mb-1">当前余额:</div>
            <div className="text-[#00e676] text-3xl font-bold font-mono tracking-tight" data-testid="text-balance">
              1198306.57
            </div>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-card border border-border rounded-lg p-3">
              <div className="text-muted-foreground text-xs mb-1">今日盈亏</div>
              <div className="text-[#00e676] font-bold" data-testid="text-today-pnl">+0.00</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-3">
              <div className="text-muted-foreground text-xs mb-1">总盈亏</div>
              <div className="text-[#f44336] font-bold" data-testid="text-total-pnl">-919000.00</div>
            </div>
          </div>

          {/* Stats Row */}
          <div className="bg-card border border-border rounded-lg p-3 grid grid-cols-4 gap-2 mb-6 divide-x divide-border">
            <div className="text-center">
              <div className="text-muted-foreground text-[10px] mb-1">总投注</div>
              <div className="text-sm font-medium" data-testid="text-total-bets">17次</div>
            </div>
            <div className="text-center">
              <div className="text-muted-foreground text-[10px] mb-1">中奖</div>
              <div className="text-sm font-medium" data-testid="text-wins">8次</div>
            </div>
            <div className="text-center">
              <div className="text-muted-foreground text-[10px] mb-1">最大连中</div>
              <div className="text-sm font-medium" data-testid="text-max-streak">4</div>
            </div>
            <div className="text-center">
              <div className="text-muted-foreground text-[10px] mb-1">胜率</div>
              <div className="text-sm font-medium" data-testid="text-win-rate">47.06%</div>
            </div>
          </div>

          {/* Betting Records */}
          <div>
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-sm font-medium flex items-center gap-1.5">
                <span>📋</span> 投注记录
              </h3>
              <div className="flex gap-2">
                <Button size="sm" className="bg-[#2d3654] hover:bg-[#3d4664] text-white h-7 text-xs px-2" data-testid="button-search">期号搜索</Button>
                <Button size="sm" className="bg-[#2d3654] hover:bg-[#3d4664] text-white h-7 text-xs px-2" data-testid="button-reset">重置</Button>
                <Button size="sm" className="bg-transparent border border-[#f44336] text-[#f44336] hover:bg-[#f44336]/10 h-7 text-xs px-2" data-testid="button-clear-bets">🚫 清空投注</Button>
              </div>
            </div>

            <div className="rounded-md border border-border overflow-hidden text-xs">
              <table className="w-full text-center">
                <thead className="bg-[#2d3654]/50 border-b border-border">
                  <tr>
                    <th className="py-2 px-1 font-normal text-muted-foreground">期号</th>
                    <th className="py-2 px-1 font-normal text-muted-foreground">投注内容</th>
                    <th className="py-2 px-1 font-normal text-muted-foreground">开奖</th>
                    <th className="py-2 px-1 font-normal text-muted-foreground">盈亏</th>
                    <th className="py-2 px-1 font-normal text-muted-foreground">金额</th>
                    <th className="py-2 px-1 font-normal text-muted-foreground">状态</th>
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

        {/* Bottom Status Bar */}
        <div className="absolute bottom-0 left-0 w-full bg-[#1a1f2e] border-t border-border p-2 text-[10px] text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis px-4 z-10 shadow-[0_-4px_10px_rgba(0,0,0,0.2)]">
          {latestTerm ? (
            <>
              <span className="text-white/70">{latestTerm.term}期:</span>{' '}
              {latestTerm.sum1}+{latestTerm.sum2}+{latestTerm.sum3}={latestTerm.result}{' '}
              <span className="text-[#4CA2FF]">{latestTerm.r3}</span>
            </>
          ) : (
            <span className="text-white/70">3433393:</span>
          )}{' '}
          单金额 <span className="text-[#f44336]">-39200</span> 金额 <span className="text-white/60">400000</span>
        </div>

        <SettingsDrawer isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
      </div>
    </div>
  );
}
