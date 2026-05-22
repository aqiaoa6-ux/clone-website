import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Users, LogOut } from 'lucide-react';

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

interface Props {
  isOpen: boolean;
  onClose: () => void;
  tgMe?: MeInfo | null;
  watchGroup?: GroupInfo | null;
  onConnectTg?: () => void;
  onSetGroup?: () => void;
  onDisconnect?: () => void;
  onOpenConfig?: () => void;
  onOpenTrend?: () => void;
  onOpenBetSetup?: () => void;
}

export default function SettingsDrawer({ isOpen, onClose, tgMe, watchGroup, onConnectTg, onSetGroup, onDisconnect, onOpenConfig, onOpenTrend, onOpenBetSetup }: Props) {
  const [normalPlay, setNormalPlay] = useState(true);
  const [followPlay, setFollowPlay] = useState(true);

  const displayName = tgMe
    ? `${tgMe.firstName ?? ''}${tgMe.lastName ? ` ${tgMe.lastName}` : ''}`.trim() || tgMe.username || String(tgMe.id)
    : '88888888';

  const initial = displayName.charAt(0).toUpperCase();

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 0.5 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black z-40"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
            transition={{ type: 'tween', duration: 0.28 }}
            className="fixed top-0 left-0 h-full w-[300px] bg-card border-r border-border z-50 flex flex-col shadow-xl overflow-y-auto"
          >
            {/* Profile */}
            <div className="p-6 flex flex-col items-center border-b border-border/50">
              <div className="w-16 h-16 rounded-full bg-blue-600 text-white flex items-center justify-center text-2xl font-bold mb-3 shadow-lg">
                {initial}
              </div>
              <h2 className="text-xl font-bold text-white mb-1">{displayName}</h2>
              {tgMe ? (
                <div className="flex flex-col items-center gap-1">
                  {tgMe.username && <p className="text-xs text-[#4CA2FF]">@{tgMe.username}</p>}
                  <div className="flex items-center gap-1.5 mt-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    <p className="text-xs text-green-400">Telegram 已连接</p>
                  </div>
                  {watchGroup && (
                    <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                      <Users className="w-3 h-3" />
                      <span className="truncate max-w-[180px]">{watchGroup.title}</span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Telegram未连接</p>
              )}
            </div>

            <div className="p-4 flex-1">
              <div className="text-xs text-muted-foreground mb-4">策略配置</div>

              <div className="space-y-3">
                <Button className="w-full bg-gradient-to-r from-[#3b5de7] to-[#7c3aed] hover:opacity-90 text-white border-0 font-semibold" onClick={() => { onOpenBetSetup?.(); }}>
                  ⚡ 智能投注设置
                </Button>

                <Button className="w-full bg-[#1e2538] hover:bg-[#2d3654] text-white border border-white/10" onClick={() => { onOpenConfig?.(); }}>
                  高级投注配置
                </Button>

                <div className="flex items-center justify-between py-2 px-1">
                  <span className="text-sm">常规玩法</span>
                  <Switch checked={normalPlay} onCheckedChange={setNormalPlay} className="data-[state=checked]:bg-[#3b5de7]" />
                </div>

                <div className="flex items-center justify-between py-2 px-1">
                  <span className="text-sm">追号设置</span>
                  <Switch checked={followPlay} onCheckedChange={setFollowPlay} className="data-[state=checked]:bg-[#3b5de7]" />
                </div>

                <Button className="w-full bg-transparent border border-[#c8a520] text-[#c8a520] hover:bg-[#c8a520]/10">
                  自动追号(专业版)
                </Button>

                <Button className="w-full bg-[#5c1a1a] hover:bg-[#8b2020] text-white border-0">
                  清除TG缓存
                </Button>

                <Button variant="secondary" className="w-full bg-[#2d3654] hover:bg-[#3d4664] text-white border-0" onClick={() => { onOpenTrend?.(); }}>
                  开奖走势
                </Button>
              </div>

              <div className="h-px bg-border/50 my-5" />

              {/* Telegram section */}
              {tgMe ? (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground mb-3">Telegram 操作</div>
                  <Button
                    onClick={() => { onSetGroup?.(); }}
                    className="w-full bg-[#2d3654] hover:bg-[#3d4664] text-white border-0 flex gap-2"
                  >
                    <Users className="w-4 h-4" />
                    {watchGroup ? '更换投注群' : '设置投注群'}
                  </Button>
                  <Button
                    onClick={() => { onDisconnect?.(); onClose(); }}
                    className="w-full bg-transparent border border-[#f44336]/50 text-[#f44336] hover:bg-[#f44336]/10 flex gap-2"
                  >
                    <LogOut className="w-4 h-4" />
                    断开 Telegram
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground mb-3">Telegram 登录</div>
                  <Button
                    onClick={() => { onConnectTg?.(); }}
                    className="w-full bg-[#3b5de7] hover:bg-blue-600 text-white border-0"
                  >
                    连接 Telegram
                  </Button>
                </div>
              )}

              <div className="h-px bg-border/50 my-5" />

              <div className="mb-4 flex items-center gap-2">
                <span className="text-lg">🔑</span>
                <span className="text-sm">卡密验证</span>
              </div>
              <div className="flex items-center text-sm px-1 mb-4">
                <span className="text-muted-foreground mr-2">到期时间:</span>
                <span className="text-[#f44336]">已过期</span>
              </div>
            </div>

            <div className="p-4 space-y-3 border-t border-border/50">
              <Button variant="secondary" className="w-full bg-[#2d3654] hover:bg-[#3d4664] text-white border-0">
                修改密码
              </Button>
              <Button variant="secondary" className="w-full bg-[#2d3654] hover:bg-[#3d4664] text-[#f44336] border-0">
                退出登录
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
