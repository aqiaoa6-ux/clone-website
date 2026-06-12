import { useLocation } from "wouter";
import { useAuth } from "../context/AuthContext";

export default function BottomNav() {
  const { user, card, countdown } = useAuth();
  const [location, setLocation] = useLocation();

  // Determine badge for card icon
  const cardBadge = card?.active
    ? (countdown ?? null)   // show live countdown
    : "未激活";

  // Warning color when < 1 hour remaining
  const isUrgent = card?.active && countdown && !countdown.includes("天") && parseInt(countdown.split(":")[0] ?? "99") < 1;

  const items = [
    { path: "/",         icon: "🏠", label: "主控台", show: true },
    { path: "/hash2",    icon: "#️⃣", label: "哈希2",  show: true },
    { path: "/trend",    icon: "📊", label: "走势",   show: true },
    { path: "/card-key", icon: "🎫", label: "卡密",   show: true },
    { path: "/tutorial", icon: "📖", label: "教程",   show: true },
    { path: "/admin",    icon: "⚙️", label: "后台",   show: !!user?.isAdmin },
  ].filter(i => i.show);

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-[#0b0e1a]/95 border-t border-[#1e2235] backdrop-blur">
      <div className="max-w-lg mx-auto flex">
        {items.map(item => {
          const active = location === item.path;
          const badge = item.path === "/card-key" ? cardBadge : null;
          return (
            <button
              key={item.path}
              onClick={() => setLocation(item.path)}
              className={`flex-1 flex flex-col items-center gap-1 py-3 transition relative
                ${active ? "text-blue-400" : "text-slate-500 hover:text-slate-300"}`}
            >
              <span className="text-xl leading-none">{item.icon}</span>
              <span className="text-[11px] font-medium">{item.label}</span>
              {badge && (
                <span className={`absolute top-1.5 right-[5%] text-[8px] px-1 py-0.5 rounded-full leading-none font-mono whitespace-nowrap
                  ${card?.active
                    ? isUrgent
                      ? "bg-red-500/90 text-white animate-pulse"
                      : "bg-emerald-700/80 text-emerald-100"
                    : "bg-red-500 text-white"}`}>
                  {badge}
                </span>
              )}
              {active && (
                <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-6 h-0.5 bg-blue-400 rounded-full" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
