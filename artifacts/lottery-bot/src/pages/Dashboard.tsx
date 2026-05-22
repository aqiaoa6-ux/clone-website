import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Menu, Moon } from 'lucide-react';
import SettingsDrawer from '@/components/SettingsDrawer';

export default function Dashboard() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [countdown, setCountdown] = useState(107);
  const [period, setPeriod] = useState(3435746);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setPeriod(p => p + 1);
          return 180;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const mockRecords = [
    { period: 3433396, content: '27', result: '20', pnl: -5000.00, amount: 5000.00, status: '挂' },
    { period: 3433396, content: '单', result: '双', pnl: -800000.00, amount: 800000.00, status: '挂' },
    { period: 3433395, content: '27', result: '11', pnl: -5000.00, amount: 5000.00, status: '挂' },
    { period: 3433395, content: '双', result: '单', pnl: -400000.00, amount: 400000.00, status: '挂' },
    { period: 3433394, content: '27', result: '11', pnl: -5000.00, amount: 5000.00, status: '挂' },
    { period: 3433394, content: '双', result: '单', pnl: -200000.00, amount: 200000.00, status: '挂' },
    { period: 3433393, content: '27', result: '11', pnl: -5000.00, amount: 5000.00, status: '挂' },
    { period: 3433393, content: '双', result: '单', pnl: -39200.00, amount: 400000.00, status: '挂' },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex justify-center pb-8 relative">
      <div className="w-full max-w-[430px] bg-background shadow-2xl overflow-hidden flex flex-col relative">
        
        {/* Top Header */}
        <div className="flex items-center justify-between p-3 border-b border-border/50">
          <Button variant="ghost" size="icon" onClick={() => setDrawerOpen(true)} className="text-muted-foreground hover:text-white">
            <Menu className="w-6 h-6" />
          </Button>
          
          <div className="flex items-center gap-2">
            <Button size="sm" className="bg-[#3b5de7] hover:bg-blue-600 text-white h-8 text-xs px-3">
              连接TG
            </Button>
            <Button 
              size="sm" 
              className={`${isRunning ? 'bg-orange-600 hover:bg-orange-700' : 'bg-[#00e676] hover:bg-green-600'} text-white h-8 text-xs px-4`}
              onClick={() => setIsRunning(!isRunning)}
            >
              {isRunning ? '运行中' : '启动'}
            </Button>
            <Button size="sm" className="bg-[#f44336] hover:bg-red-600 text-white h-8 text-xs px-4">
              停止
            </Button>
          </div>

          <Button variant="ghost" size="icon" className="text-muted-foreground">
            <Moon className="w-5 h-5" />
          </Button>
        </div>

        <div className="p-4 flex-1 overflow-y-auto">
          {/* Period Info */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2 text-lg">
              <span className="text-[#3b5de7] font-medium">{period}期:</span>
              <span className="text-[#c8a520] font-bold">{countdown}秒</span>
            </div>
            <div className="flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">上期:</span>
              <div className="flex items-center gap-1">
                <span className="w-6 h-6 rounded-full bg-[#3b5de7]/20 border border-[#3b5de7]/50 text-[#3b5de7] flex items-center justify-center font-bold text-xs">4</span>
                <span className="text-muted-foreground text-xs">+</span>
                <span className="w-6 h-6 rounded-full bg-[#3b5de7]/20 border border-[#3b5de7]/50 text-[#3b5de7] flex items-center justify-center font-bold text-xs">3</span>
                <span className="text-muted-foreground text-xs">+</span>
                <span className="w-6 h-6 rounded-full bg-[#3b5de7]/20 border border-[#3b5de7]/50 text-[#3b5de7] flex items-center justify-center font-bold text-xs">6</span>
                <span className="text-muted-foreground text-xs">=</span>
                <span className="w-6 h-6 rounded-full bg-[#f44336]/20 border border-[#f44336]/50 text-[#f44336] flex items-center justify-center font-bold text-xs">13</span>
              </div>
              <span className="text-muted-foreground text-xs ml-1">(小单)</span>
            </div>
          </div>

          {/* Balance Display */}
          <div className="bg-card border border-border rounded-lg p-4 mb-4">
            <div className="text-muted-foreground text-sm mb-1">当前余额:</div>
            <div className="text-[#00e676] text-3xl font-bold font-mono tracking-tight">1198306.57</div>
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
            <div className="text-center">
              <div className="text-muted-foreground text-[10px] mb-1">总投注</div>
              <div className="text-sm font-medium">17次</div>
            </div>
            <div className="text-center">
              <div className="text-muted-foreground text-[10px] mb-1">中奖</div>
              <div className="text-sm font-medium">8次</div>
            </div>
            <div className="text-center">
              <div className="text-muted-foreground text-[10px] mb-1">最大连中</div>
              <div className="text-sm font-medium">4</div>
            </div>
            <div className="text-center">
              <div className="text-muted-foreground text-[10px] mb-1">胜率</div>
              <div className="text-sm font-medium">47.06%</div>
            </div>
          </div>

          {/* Betting Records */}
          <div>
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-sm font-medium flex items-center gap-1.5">
                <span>📋</span> 投注记录
              </h3>
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
                    <tr key={i} className="hover:bg-muted/50">
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
          <span className="text-white/70">3433393:</span> 单金额 <span className="text-[#f44336]">-39200</span> 金额 <span className="text-white/60">400000</span>
        </div>

        <SettingsDrawer isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
      </div>
    </div>
  );
}
