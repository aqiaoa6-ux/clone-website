import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';

interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsDrawer({ isOpen, onClose }: SettingsDrawerProps) {
  const [normalPlay, setNormalPlay] = React.useState(true);
  const [followPlay, setFollowPlay] = React.useState(true);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black z-40"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'tween', duration: 0.3 }}
            className="fixed top-0 left-0 h-full w-[300px] bg-card border-r border-border z-50 flex flex-col shadow-xl"
          >
            {/* Profile Section */}
            <div className="p-6 flex flex-col items-center border-b border-border/50">
              <div className="w-16 h-16 rounded-full bg-blue-600 text-white flex items-center justify-center text-2xl font-bold mb-3 shadow-lg">
                8
              </div>
              <h2 className="text-xl font-bold text-white mb-1">88888888</h2>
              <p className="text-sm text-muted-foreground">Telegram未连接</p>
            </div>

            <div className="p-4 flex-1 overflow-y-auto">
              <div className="text-xs text-muted-foreground mb-4">策略配置</div>

              <div className="space-y-3">
                <Button className="w-full bg-[#3b5de7] hover:bg-blue-600 text-white border-0">
                  全局设置
                </Button>

                <div className="flex items-center justify-between py-2 px-1">
                  <span className="text-sm text-foreground">常规玩法</span>
                  <Switch
                    checked={normalPlay}
                    onCheckedChange={setNormalPlay}
                    className="data-[state=checked]:bg-[#3b5de7]"
                  />
                </div>

                <div className="flex items-center justify-between py-2 px-1">
                  <span className="text-sm text-foreground">追号设置</span>
                  <Switch
                    checked={followPlay}
                    onCheckedChange={setFollowPlay}
                    className="data-[state=checked]:bg-[#3b5de7]"
                  />
                </div>

                <Button className="w-full bg-transparent border border-[#c8a520] text-[#c8a520] hover:bg-[#c8a520]/10 mt-2">
                  自动追号(专业版)
                </Button>

                <Button className="w-full bg-[#5c1a1a] hover:bg-[#8b2020] text-white border-0">
                  清除TG缓存
                </Button>

                <Button variant="secondary" className="w-full bg-[#2d3654] hover:bg-[#3d4664] text-white border-0">
                  开奖走势
                </Button>
              </div>

              <div className="h-px bg-border/50 my-6" />

              <div className="mb-4 flex items-center gap-2">
                <span className="text-lg">🔑</span>
                <span className="text-sm text-foreground">卡密验证</span>
              </div>
              
              <div className="flex items-center text-sm px-1 mb-8">
                <span className="text-muted-foreground mr-2">到期时间:</span>
                <span className="text-[#f44336]">已过期</span>
              </div>
            </div>

            <div className="p-4 space-y-3 mt-auto border-t border-border/50">
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
