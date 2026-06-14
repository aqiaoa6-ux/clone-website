import { useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";

export default function HomePage() {
  const { user, card, logout } = useAuth();
  const [, setLocation] = useLocation();

  const cardActive = Boolean(card?.active) || Boolean(user?.isAdmin);

  return (
    <div className="min-h-screen bg-[#0b0e1a] text-white px-4 py-6">
      <div className="max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="text-xl font-bold">首页</div>
            <div className="text-xs text-slate-500 mt-1">
              只保留哈希2和加拿大两个前台入口
            </div>
          </div>
          <button
            onClick={() => void logout()}
            className="text-xs px-3 py-1.5 rounded-lg border border-red-500/40 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition"
          >
            退出登录
          </button>
        </div>

        <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4 mb-4">
          <div className="text-sm text-slate-400">当前账号</div>
          <div className="text-base font-semibold mt-1">{user?.username ?? "-"}</div>
          <div className="text-xs text-slate-500 mt-2">
            {user?.isAdmin ? "管理员账号" : card?.active ? "卡密已激活" : "卡密未激活"}
          </div>
        </div>

        {!cardActive && (
          <div className="bg-amber-500/10 border border-amber-500/20 text-amber-200 rounded-2xl p-4 mb-4">
            <div className="text-sm font-medium">先激活卡密再进入前台</div>
            <button
              onClick={() => setLocation("/card-key")}
              className="mt-3 px-4 py-2 rounded-xl bg-amber-500 text-[#0b0e1a] text-sm font-medium"
            >
              去激活卡密
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3">
          <button
            onClick={() => setLocation("/hash2")}
            disabled={!cardActive}
            className="w-full rounded-2xl border border-[#252a3d] bg-[#161929] p-4 text-left disabled:opacity-50"
          >
            <div className="text-base font-semibold">哈希2</div>
            <div className="text-xs text-slate-500 mt-1">进入哈希2模块</div>
          </button>

          <button
            onClick={() => setLocation("/canada")}
            disabled={!cardActive}
            className="w-full rounded-2xl border border-[#252a3d] bg-[#161929] p-4 text-left disabled:opacity-50"
          >
            <div className="text-base font-semibold">加拿大</div>
            <div className="text-xs text-slate-500 mt-1">进入加拿大模块</div>
          </button>

          {user?.isAdmin && (
            <button
              onClick={() => setLocation("/admin")}
              className="w-full rounded-2xl border border-blue-500/30 bg-blue-500/10 p-4 text-left"
            >
              <div className="text-base font-semibold text-blue-200">后台</div>
              <div className="text-xs text-blue-300/70 mt-1">只保留商店、卡密管理、账号管理</div>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
