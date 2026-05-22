import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Bot, CheckCircle2, Loader2 } from 'lucide-react';

interface BotInfo {
  id: number;
  first_name: string;
  username: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onConnected: (token: string, bot: BotInfo) => void;
}

export default function TelegramConnectModal({ isOpen, onClose, onConnected }: Props) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<BotInfo | null>(null);

  async function handleConnect() {
    if (!token.trim()) {
      setError('请输入 Bot Token');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/telegram/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = await res.json() as { ok?: boolean; bot?: BotInfo; error?: string };

      if (!res.ok || !data.ok) {
        setError(data.error ?? '连接失败');
        return;
      }

      setSuccess(data.bot!);
      setTimeout(() => {
        onConnected(token.trim(), data.bot!);
        onClose();
        setSuccess(null);
        setToken('');
      }, 1200);
    } catch {
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    if (loading) return;
    onClose();
    setError('');
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.6 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black z-50"
            onClick={handleClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed inset-x-4 top-1/3 -translate-y-1/2 z-50 max-w-[400px] mx-auto bg-[#1e2438] border border-[#2d3654] rounded-2xl shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between p-4 border-b border-[#2d3654]">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-[#3b5de7]/20 flex items-center justify-center">
                  <Bot className="w-4 h-4 text-[#4CA2FF]" />
                </div>
                <span className="text-white font-medium">连接 Telegram</span>
              </div>
              <button
                onClick={handleClose}
                className="text-muted-foreground hover:text-white transition-colors"
                data-testid="button-close-modal"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5">
              {success ? (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col items-center py-4 gap-3"
                >
                  <CheckCircle2 className="w-12 h-12 text-green-400" />
                  <div className="text-center">
                    <div className="text-white font-semibold text-lg">{success.first_name}</div>
                    <div className="text-[#4CA2FF] text-sm">@{success.username}</div>
                  </div>
                  <div className="text-green-400 text-sm">连接成功！</div>
                </motion.div>
              ) : (
                <>
                  <p className="text-muted-foreground text-xs mb-4 leading-relaxed">
                    输入你的 Telegram Bot Token 直接连接。<br />
                    在 <span className="text-[#4CA2FF]">@BotFather</span> 发送 /newbot 或 /mybots 获取 Token。
                  </p>

                  <div className="mb-4">
                    <label className="text-xs text-muted-foreground mb-2 block">Bot Token</label>
                    <input
                      type="text"
                      value={token}
                      onChange={e => { setToken(e.target.value); setError(''); }}
                      onKeyDown={e => e.key === 'Enter' && handleConnect()}
                      placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
                      className="w-full bg-[#151a26] border border-[#2d3654] focus:border-[#3b5de7] rounded-lg px-3 py-2.5 text-white text-sm outline-none transition-colors placeholder:text-muted-foreground/50 font-mono"
                      data-testid="input-bot-token"
                      autoFocus
                    />
                    {error && (
                      <p className="text-[#f44336] text-xs mt-2">{error}</p>
                    )}
                  </div>

                  <button
                    onClick={handleConnect}
                    disabled={loading || !token.trim()}
                    className="w-full bg-[#3b5de7] hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg py-2.5 text-sm font-medium transition-colors flex items-center justify-center gap-2"
                    data-testid="button-connect"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        连接中...
                      </>
                    ) : (
                      '直接登录'
                    )}
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
