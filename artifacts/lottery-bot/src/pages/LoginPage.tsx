import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";
import { SESSION_CONFIRMED_KEY } from "../AppRoutes";

const REMEMBER_KEY = "aying_remember";

export default function LoginPage() {
  const { user, loading, login, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER_KEY);
      if (saved) {
        const { u, p } = JSON.parse(saved) as { u: string; p: string };
        setUsername(u ?? "");
        setPassword(p ?? "");
        setRemember(true);
      }
    } catch { /* ignore */ }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(username, password);
      if (remember) {
        localStorage.setItem(REMEMBER_KEY, JSON.stringify({ u: username, p: password }));
      } else {
        localStorage.removeItem(REMEMBER_KEY);
      }
      sessionStorage.setItem(SESSION_CONFIRMED_KEY, "1");
      setLocation("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleEnter = () => {
    sessionStorage.setItem(SESSION_CONFIRMED_KEY, "1");
    setLocation("/");
  };

  const handleSwitch = async () => {
    setSwitching(true);
    try {
      await logout();
    } finally {
      setSwitching(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b0e1a] flex items-center justify-center">
        <div className="text-slate-500 text-sm">加载中...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0b0e1a] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          {/* Logo */}
          <div className="flex justify-center mb-4">
            <div className="relative w-16 h-16">
              <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full drop-shadow-lg">
                <defs>
                  <radialGradient id="bg" cx="50%" cy="40%" r="55%">
                    <stop offset="0%" stopColor="#4f46e5" />
                    <stop offset="100%" stopColor="#1e1b4b" />
                  </radialGradient>
                  <radialGradient id="glow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#818cf8" stopOpacity="0.4" />
                    <stop offset="100%" stopColor="#818cf8" stopOpacity="0" />
                  </radialGradient>
                  <linearGradient id="wing" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#a5b4fc" />
                    <stop offset="100%" stopColor="#6366f1" />
                  </linearGradient>
                </defs>
                <circle cx="32" cy="32" r="30" fill="url(#bg)" />
                <circle cx="32" cy="32" r="30" fill="url(#glow)" />
                <circle cx="32" cy="32" r="29" stroke="#6366f1" strokeWidth="0.8" strokeOpacity="0.6" />
                {/* Wing / flying shape */}
                <path d="M14 34 Q24 22 36 28 Q44 32 50 26 Q46 36 36 36 Q28 36 22 40 Z" fill="url(#wing)" opacity="0.9" />
                <path d="M18 38 Q26 30 34 34 Q40 37 46 32 Q43 40 34 40 Q26 40 20 44 Z" fill="#c7d2fe" opacity="0.4" />
                {/* Center dot */}
                <circle cx="32" cy="32" r="3" fill="#e0e7ff" />
              </svg>
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-wide">暗影-飞投</h1>
          <p className="text-slate-400 text-sm mt-1">智能投注管理平台</p>
        </div>

        {/* ── 已登录状态：要求用户确认身份后才能进入 ── */}
        {user ? (
          <div className="space-y-3">
            <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-6 shadow-xl">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-full bg-blue-600/30 border border-blue-500/40 flex items-center justify-center flex-shrink-0">
                  <span className="text-blue-300 font-bold text-sm">
                    {user.username.slice(0, 1).toUpperCase()}
                  </span>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">已保存的登录账号</div>
                  <div className="text-white font-semibold">{user.username}</div>
                </div>
                {user.isAdmin && (
                  <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/20 border border-yellow-500/30 text-yellow-400">
                    管理员
                  </span>
                )}
              </div>

              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-5">
                <p className="text-amber-400 text-xs leading-relaxed">
                  如果这不是您的账号，请点击"切换账号"，然后用自己的账号登录。
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleEnter}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl py-2.5 text-sm transition"
                >
                  这是我的账号，进入
                </button>
                <button
                  onClick={() => void handleSwitch()}
                  disabled={switching}
                  className="flex-1 bg-slate-700/60 hover:bg-slate-700 border border-slate-600/50 disabled:opacity-50 text-slate-200 font-semibold rounded-xl py-2.5 text-sm transition"
                >
                  {switching ? "退出中..." : "切换账号"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ── 未登录状态：正常登录表单 ── */
          <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-white mb-5">账号登录</h2>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-4 py-3 mb-4">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1.5">用户名</label>
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="请输入用户名"
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1.5">密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition"
                  required
                />
              </div>

              {/* 记住密码 */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <div
                  onClick={() => setRemember(v => !v)}
                  className={`w-4 h-4 rounded flex items-center justify-center border transition flex-shrink-0 ${remember ? "bg-blue-600 border-blue-500" : "bg-[#0f1220] border-[#252a3d]"}`}
                >
                  {remember && (
                    <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 10 10">
                      <path d="M1.5 5L4 7.5L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
                <span className="text-sm text-slate-400" onClick={() => setRemember(v => !v)}>记住密码</span>
              </label>

              <button
                type="submit"
                disabled={submitting}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold rounded-xl py-3 transition mt-2"
              >
                {submitting ? "登录中..." : "登 录"}
              </button>
            </form>

            <p className="text-center text-sm text-slate-500 mt-5">
              没有账号？{" "}
              <Link href="/register" className="text-blue-400 hover:text-blue-300">
                立即注册
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
