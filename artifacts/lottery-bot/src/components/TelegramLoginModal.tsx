import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2, CheckCircle2, ChevronLeft, Phone, KeyRound, Lock } from 'lucide-react';

type Step = 'phone' | 'code' | 'password' | 'done';

interface MeInfo {
  id: number | bigint;
  firstName?: string;
  lastName?: string;
  username?: string;
  phone?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onConnected: (me: MeInfo) => void;
}

export default function TelegramLoginModal({ isOpen, onClose, onConnected }: Props) {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [me, setMe] = useState<MeInfo | null>(null);
  const codeRefs = useRef<(HTMLInputElement | null)[]>([]);
  const codeDigits = code.padEnd(5, '').split('').slice(0, 5);

  useEffect(() => {
    if (!isOpen) {
      setTimeout(() => {
        setStep('phone');
        setPhone('');
        setCode('');
        setPassword('');
        setError('');
        setMe(null);
      }, 300);
    }
  }, [isOpen]);

  useEffect(() => {
    if (step === 'code') {
      setTimeout(() => codeRefs.current[0]?.focus(), 100);
    }
  }, [step]);

  async function handleSendCode() {
    if (!phone.trim()) { setError('请输入手机号'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/tg/send-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) { setError(data.error ?? '发送失败'); return; }
      setStep('code');
    } catch { setError('网络错误，请重试'); }
    finally { setLoading(false); }
  }

  async function handleVerifyCode() {
    if (code.length < 5) { setError('请输入完整验证码'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/tg/verify-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json() as { ok: boolean; needPassword?: boolean; me?: MeInfo; error?: string };
      if (!res.ok) { setError(data.error ?? '验证失败'); return; }
      if (data.needPassword) { setStep('password'); return; }
      if (data.ok && data.me) { setMe(data.me); setStep('done'); onConnected(data.me); }
    } catch { setError('网络错误，请重试'); }
    finally { setLoading(false); }
  }

  async function handleVerifyPassword() {
    if (!password.trim()) { setError('请输入二步验证密码'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/tg/verify-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json() as { ok: boolean; me?: MeInfo; error?: string };
      if (!res.ok) { setError(data.error ?? '密码错误'); return; }
      if (data.ok && data.me) { setMe(data.me); setStep('done'); onConnected(data.me); }
    } catch { setError('网络错误，请重试'); }
    finally { setLoading(false); }
  }

  function handleCodeInput(idx: number, val: string) {
    const digit = val.replace(/\D/g, '').slice(-1);
    const arr = code.padEnd(5, '').split('').slice(0, 5);
    arr[idx] = digit;
    const newCode = arr.join('').replace(/ /g, '');
    setCode(newCode);
    setError('');
    if (digit && idx < 4) codeRefs.current[idx + 1]?.focus();
    if (newCode.length === 5) setTimeout(() => handleVerifyCodeAuto(newCode), 200);
  }

  function handleCodeKey(idx: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace') {
      const arr = code.padEnd(5, '').split('').slice(0, 5);
      if (!arr[idx] && idx > 0) {
        arr[idx - 1] = '';
        setCode(arr.join('').replace(/ /g, ''));
        codeRefs.current[idx - 1]?.focus();
      } else {
        arr[idx] = '';
        setCode(arr.join('').replace(/ /g, ''));
      }
    }
  }

  async function handleVerifyCodeAuto(autoCode: string) {
    if (autoCode.length < 5) return;
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/tg/verify-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: autoCode }),
      });
      const data = await res.json() as { ok: boolean; needPassword?: boolean; me?: MeInfo; error?: string };
      if (!res.ok) { setError(data.error ?? '验证失败'); return; }
      if (data.needPassword) { setStep('password'); return; }
      if (data.ok && data.me) { setMe(data.me); setStep('done'); onConnected(data.me); }
    } catch { setError('网络错误，请重试'); }
    finally { setLoading(false); }
  }

  const stepTitles: Record<Step, string> = {
    phone: '连接 Telegram',
    code: '输入验证码',
    password: '二步验证',
    done: '登录成功',
  };

  const stepIcons: Record<Step, React.ReactNode> = {
    phone: <Phone className="w-4 h-4 text-[#4CA2FF]" />,
    code: <KeyRound className="w-4 h-4 text-[#4CA2FF]" />,
    password: <Lock className="w-4 h-4 text-[#4CA2FF]" />,
    done: <CheckCircle2 className="w-4 h-4 text-green-400" />,
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 0.65 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black z-50"
            onClick={() => { if (!loading) onClose(); }}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.93, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.93, y: 24 }}
            transition={{ type: 'spring', damping: 26, stiffness: 320 }}
            className="fixed z-50 inset-x-4 max-w-[400px] mx-auto top-1/2 -translate-y-1/2 bg-[#1e2438] border border-[#2d3654] rounded-2xl shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[#2d3654]/70">
              <div className="flex items-center gap-2">
                {step !== 'phone' && step !== 'done' && (
                  <button
                    onClick={() => { setStep(step === 'password' ? 'code' : 'phone'); setError(''); }}
                    className="text-muted-foreground hover:text-white mr-1"
                    disabled={loading}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                )}
                <div className="w-7 h-7 rounded-full bg-[#3b5de7]/20 flex items-center justify-center">
                  {stepIcons[step]}
                </div>
                <span className="text-white font-semibold text-sm">{stepTitles[step]}</span>
              </div>
              <button onClick={() => { if (!loading) onClose(); }} className="text-muted-foreground hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Steps indicator */}
            {step !== 'done' && (
              <div className="flex gap-1.5 px-5 pt-3">
                {(['phone', 'code', 'password'] as Step[]).map((s, i) => (
                  <div
                    key={s}
                    className="h-0.5 flex-1 rounded-full transition-colors duration-300"
                    style={{
                      backgroundColor:
                        step === s ? '#3b5de7'
                          : (step === 'code' && i === 0) || (step === 'password' && i <= 1) ? '#3b5de7'
                            : '#2d3654',
                    }}
                  />
                ))}
              </div>
            )}

            <div className="p-5">
              <AnimatePresence mode="wait">

                {/* Step 1: Phone */}
                {step === 'phone' && (
                  <motion.div key="phone" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.18 }}>
                    <p className="text-muted-foreground text-xs mb-4 leading-relaxed">
                      输入你的 Telegram 手机号（需含国际区号），系统将发送验证码到你的 Telegram。
                    </p>
                    <label className="text-xs text-muted-foreground mb-1.5 block">手机号</label>
                    <input
                      type="tel"
                      value={phone}
                      onChange={e => { setPhone(e.target.value); setError(''); }}
                      onKeyDown={e => e.key === 'Enter' && handleSendCode()}
                      placeholder="+86 138 0000 0000"
                      className="w-full bg-[#151a26] border border-[#2d3654] focus:border-[#3b5de7] rounded-lg px-3 py-2.5 text-white text-sm outline-none transition-colors placeholder:text-muted-foreground/40 font-mono tracking-wide"
                      autoFocus
                      data-testid="input-phone"
                    />
                    {error && <p className="text-[#f44336] text-xs mt-2">{error}</p>}
                    <button
                      onClick={handleSendCode}
                      disabled={loading || !phone.trim()}
                      className="mt-4 w-full bg-[#3b5de7] hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg py-2.5 text-sm font-medium transition-colors flex items-center justify-center gap-2"
                      data-testid="button-send-code"
                    >
                      {loading ? <><Loader2 className="w-4 h-4 animate-spin" />发送中...</> : '发送验证码'}
                    </button>
                  </motion.div>
                )}

                {/* Step 2: Code */}
                {step === 'code' && (
                  <motion.div key="code" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.18 }}>
                    <p className="text-muted-foreground text-xs mb-1 leading-relaxed">
                      验证码已发送至 <span className="text-white">{phone}</span> 的 Telegram
                    </p>
                    <p className="text-muted-foreground text-xs mb-5">打开 Telegram 查看「Telegram」发来的消息</p>

                    <div className="flex gap-2.5 justify-center mb-1">
                      {[0, 1, 2, 3, 4].map(i => (
                        <input
                          key={i}
                          ref={el => { codeRefs.current[i] = el; }}
                          type="text"
                          inputMode="numeric"
                          maxLength={1}
                          value={codeDigits[i] === ' ' ? '' : codeDigits[i] ?? ''}
                          onChange={e => handleCodeInput(i, e.target.value)}
                          onKeyDown={e => handleCodeKey(i, e)}
                          className="w-11 h-12 text-center bg-[#151a26] border border-[#2d3654] focus:border-[#3b5de7] rounded-lg text-white text-xl font-bold outline-none transition-colors caret-transparent"
                          data-testid={`input-code-${i}`}
                        />
                      ))}
                    </div>
                    {error && <p className="text-[#f44336] text-xs mt-2 text-center">{error}</p>}

                    <button
                      onClick={handleVerifyCode}
                      disabled={loading || code.length < 5}
                      className="mt-4 w-full bg-[#3b5de7] hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg py-2.5 text-sm font-medium transition-colors flex items-center justify-center gap-2"
                      data-testid="button-verify-code"
                    >
                      {loading ? <><Loader2 className="w-4 h-4 animate-spin" />验证中...</> : '确认验证码'}
                    </button>
                    <button
                      onClick={() => { setStep('phone'); setCode(''); setError(''); }}
                      disabled={loading}
                      className="mt-2 w-full text-muted-foreground hover:text-white text-xs py-2 transition-colors"
                    >
                      重新发送验证码
                    </button>
                  </motion.div>
                )}

                {/* Step 3: 2FA Password */}
                {step === 'password' && (
                  <motion.div key="password" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.18 }}>
                    <p className="text-muted-foreground text-xs mb-4 leading-relaxed">
                      你的账号已开启二步验证，请输入你在 Telegram 中设置的额外密码。
                    </p>
                    <label className="text-xs text-muted-foreground mb-1.5 block">二步验证密码</label>
                    <input
                      type="password"
                      value={password}
                      onChange={e => { setPassword(e.target.value); setError(''); }}
                      onKeyDown={e => e.key === 'Enter' && handleVerifyPassword()}
                      placeholder="输入二步验证密码"
                      className="w-full bg-[#151a26] border border-[#2d3654] focus:border-[#3b5de7] rounded-lg px-3 py-2.5 text-white text-sm outline-none transition-colors placeholder:text-muted-foreground/40"
                      autoFocus
                      data-testid="input-2fa-password"
                    />
                    {error && <p className="text-[#f44336] text-xs mt-2">{error}</p>}
                    <button
                      onClick={handleVerifyPassword}
                      disabled={loading || !password.trim()}
                      className="mt-4 w-full bg-[#3b5de7] hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg py-2.5 text-sm font-medium transition-colors flex items-center justify-center gap-2"
                      data-testid="button-verify-password"
                    >
                      {loading ? <><Loader2 className="w-4 h-4 animate-spin" />验证中...</> : '确认登录'}
                    </button>
                  </motion.div>
                )}

                {/* Done */}
                {step === 'done' && me && (
                  <motion.div key="done" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center py-4 gap-3">
                    <CheckCircle2 className="w-14 h-14 text-green-400" />
                    <div className="text-center">
                      <div className="text-white font-semibold text-lg">
                        {me.firstName}{me.lastName ? ` ${me.lastName}` : ''}
                      </div>
                      {me.username && <div className="text-[#4CA2FF] text-sm">@{me.username}</div>}
                      {me.phone && <div className="text-muted-foreground text-xs mt-1">{me.phone}</div>}
                    </div>
                    <div className="text-green-400 text-sm font-medium">已成功连接 Telegram</div>
                  </motion.div>
                )}

              </AnimatePresence>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
