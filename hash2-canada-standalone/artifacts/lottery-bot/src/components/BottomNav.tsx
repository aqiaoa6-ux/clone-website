import { useLocation } from "wouter";

export default function BottomNav() {
  const [location, setLocation] = useLocation();

  const items = [
    { path: "/hash2",    icon: "#️⃣", label: "哈希2",  show: true },
    { path: "/canada",   icon: "🍁", label: "加拿大", show: true },
  ].filter(i => i.show);

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-[#0b0e1a]/95 border-t border-[#1e2235] backdrop-blur">
      <div className="max-w-lg mx-auto flex">
        {items.map(item => {
          const active = location === item.path
            || (item.path === "/hash2" && location.startsWith("/hash2/"))
            || (item.path === "/canada" && location.startsWith("/canada/"));
          return (
            <button
              key={item.path}
              onClick={() => setLocation(item.path)}
              className={`flex-1 flex flex-col items-center gap-1 py-3 transition relative
                ${active ? "text-blue-400" : "text-slate-500 hover:text-slate-300"}`}
            >
              <span className="text-xl leading-none">{item.icon}</span>
              <span className="text-[11px] font-medium">{item.label}</span>
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
