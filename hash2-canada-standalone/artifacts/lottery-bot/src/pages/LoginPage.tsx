import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 清除旧的记住密码缓存
  useEffect(() => {
    localStorage.removeItem("aying_remember");
  }, []);

  // 已登录直接跳转，不显示确认卡片
  useEffect(() => {
    if (!loading && user) {
      setLocation("/");
    }
  }, [loading, user, setLocation]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(username, password);
      setLocation("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setSubmitting(false);
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
          <div className="flex justify-center mb-4">
            <div className="relative w-16 h-16">
              <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full drop-shadow-lg">
                <defs>
                  <radialGradient id="potatoBg" cx="50%" cy="40%" r="60%">
                    <stop offset="0%" stopColor="#2b1f3d" />
                    <stop offset="100%" stopColor="#0f0b18" />
                  </radialGradient>
                </defs>
                <circle cx="32" cy="32" r="30" fill="url(#potatoBg)" />
                <ellipse cx="32" cy="36" rx="16" ry="19" fill="#C58A4B" />
                <ellipse cx="27" cy="31" rx="2.2" ry="1.8" fill="#9C6A3C" />
                <ellipse cx="37" cy="39" rx="1.8" ry="1.4" fill="#9C6A3C" />
                <ellipse cx="31" cy="44" rx="1.6" ry="1.3" fill="#9C6A3C" />
                <path d="M33 18C35 12 40 10 45 11C43 16 39 20 34 21L33 18Z" fill="#69C36D" />
                <path d="M30 19C28 14 23 12 18 14C20 18 24 22 29 23L30 19Z" fill="#88D98F" />
              </svg>
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-wide">土豆飞投</h1>
          <p className="text-slate-400 text-sm mt-1">智能投注管理平台</p>
        </div>

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
                autoComplete="off"
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
                autoComplete="new-password"
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
      </div>
    </div>
  );
}
