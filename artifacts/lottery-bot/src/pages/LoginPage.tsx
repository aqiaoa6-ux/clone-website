import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";
import { SESSION_CONFIRMED_KEY } from "../AppRoutes";

export default function LoginPage() {
  const { user, loading, login, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [switching, setSwitching] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(username, password);
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
          <div className="text-4xl mb-3">🎰</div>
          <h1 className="text-2xl font-bold text-white">暗影-飞投</h1>
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
          <>
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

            <div className="mt-4 bg-[#161929] border border-yellow-500/30 rounded-2xl p-4 flex items-center gap-3">
              <span className="text-2xl">⚙️</span>
              <div className="flex-1 min-w-0">
                <div className="text-yellow-400 text-sm font-semibold">管理员后台</div>
                <div className="text-slate-500 text-xs mt-0.5">登录管理员账号后，底部导航可直接进入后台</div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
