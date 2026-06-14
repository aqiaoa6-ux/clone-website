import { useEffect, useMemo, useState } from "react";
import { api, type TgGroup, type TgStatus } from "../lib/api";

type TgStep = "login" | "group" | "ready";

const TG_LAST_GROUP_KEY = "tg_last_group_id_v1";

function TgLoginCard({
  onDone,
}: {
  onDone: () => Promise<unknown> | void;
}) {
  const [step, setStep] = useState<"phone" | "code" | "password">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const send = async (fn: () => Promise<void>) => {
    setError("");
    setLoading(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-5 mb-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">📱</span>
        <h3 className="text-white font-semibold">连接 Telegram</h3>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg px-3 py-2 mb-3">{error}</div>}

      {step === "phone" && (
        <div className="space-y-3">
          <input
            type="tel" value={phone} onChange={e => setPhone(e.target.value)}
            placeholder="+8613800001234（含国际区号）"
            className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-4 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
          <button
            disabled={loading || !phone.trim()}
            onClick={() => void send(async () => { await api.tg.sendCode(phone.trim()); setStep("code"); })}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold rounded-xl py-2.5 transition"
          >
            {loading ? "发送中..." : "发送验证码"}
          </button>
        </div>
      )}

      {step === "code" && (
        <div className="space-y-3">
          <p className="text-slate-400 text-xs">验证码已发送到 {phone}</p>
          <input
            type="text" value={code} onChange={e => setCode(e.target.value)}
            placeholder="请输入验证码"
            className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-4 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
          <button
            disabled={loading || !code.trim()}
            onClick={() =>
              void send(async () => {
                const result = await api.tg.verifyCode(code.trim());
                if (result.needPassword) {
                  setStep("password");
                  return;
                }
                await onDone();
              })
            }
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold rounded-xl py-2.5 transition"
          >
            {loading ? "验证中..." : "验证"}
          </button>
          <button onClick={() => setStep("phone")} className="w-full text-slate-500 text-xs hover:text-slate-300 transition">重新发送</button>
        </div>
      )}

      {step === "password" && (
        <div className="space-y-3">
          <p className="text-slate-400 text-xs">需要二步验证密码</p>
          <input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="二步验证密码"
            className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-4 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
          <button
            disabled={loading || !password.trim()}
            onClick={() =>
              void send(async () => {
                await api.tg.verifyPassword(password.trim());
                await onDone();
              })
            }
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold rounded-xl py-2.5 transition"
          >
            {loading ? "验证中..." : "确认"}
          </button>
        </div>
      )}
    </div>
  );
}

function TgGroupCard({
  groups,
  onDone,
  onRelogin,
}: {
  groups: TgGroup[];
  onDone: () => Promise<unknown> | void;
  onRelogin: () => Promise<unknown> | void;
}) {
  const [link, setLink] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const filteredGroups = useMemo(
    () => groups.filter(group => group.title.toLowerCase().includes(search.toLowerCase())),
    [groups, search],
  );

  const selectGroup = async (groupId: string) => {
    setError("");
    setLoading(true);
    try {
      await api.tg.setGroup(groupId);
      try {
        localStorage.setItem(TG_LAST_GROUP_KEY, groupId);
      } catch {
        // ignore
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "设置群组失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-5 mb-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">💬</span>
        <h3 className="text-white font-semibold">选择投注群组</h3>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg px-3 py-2 mb-3">{error}</div>}

      <div className="flex gap-2 mb-3">
        <input
          type="text" value={link} onChange={e => setLink(e.target.value)}
          placeholder="粘贴群链接 t.me/..."
          className="flex-1 bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500"
        />
        <button
          disabled={loading || !link.trim()}
          onClick={() =>
            void (async () => {
              setLoading(true);
              setError("");
              try {
                const result = await api.tg.resolveGroup(link.trim());
                await selectGroup(result.group.id);
              } catch (e) {
                setError(e instanceof Error ? e.message : "解析群链接失败");
              } finally {
                setLoading(false);
              }
            })()
          }
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm px-4 rounded-xl transition"
        >
          {loading ? "..." : "搜索"}
        </button>
      </div>

      {groups.length > 0 && (
        <>
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="搜索已加入的群..."
            className="w-full bg-[#0f1220] border border-[#252a3d] rounded-xl px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-blue-500 mb-2"
          />
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {filteredGroups.map(group => (
              <button key={group.id} onClick={() => void selectGroup(group.id)}
                className="w-full text-left flex items-center gap-3 bg-[#0f1220] hover:bg-[#1a1f35] border border-transparent hover:border-blue-500/30 rounded-xl px-3 py-2 transition">
                <span className="text-slate-400">{group.type === "channel" ? "📢" : "💬"}</span>
                <div>
                  <div className="text-white text-sm">{group.title}</div>
                  {group.membersCount && <div className="text-slate-600 text-[10px]">{group.membersCount} 成员</div>}
                </div>
              </button>
            ))}
            {filteredGroups.length === 0 && (
              <div className="text-center text-slate-600 text-xs py-3">暂无匹配群组</div>
            )}
          </div>
        </>
      )}

      {groups.length === 0 && (
        <div className="rounded-xl border border-dashed border-[#252a3d] px-3 py-4 text-center text-xs text-slate-500">
          暂无可选群组，请先把 TG 账号加入目标群
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-[#1e2235]">
        <button
          onClick={() => { void api.tg.disconnect().catch(() => {}); void onRelogin(); }}
          className="w-full text-slate-500 hover:text-rose-400 text-xs transition py-1"
        >
          切换 / 重新连接 Telegram 账号
        </button>
      </div>
    </div>
  );
}

export default function TgAccessPanel({
  tgStatus,
  onStatusChange,
}: {
  tgStatus: TgStatus | null;
  onStatusChange: (status: TgStatus) => void;
}) {
  const [step, setStep] = useState<TgStep>("login");
  const [groups, setGroups] = useState<TgGroup[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);

  useEffect(() => {
    if (!tgStatus?.connected) {
      setStep("login");
      return;
    }
    if (!tgStatus.watchGroupId) {
      setStep("group");
      return;
    }
    setStep("ready");
  }, [tgStatus?.connected, tgStatus?.watchGroupId]);

  const refreshStatus = async () => {
    const next = await api.tg.status();
    onStatusChange(next);
    return next;
  };

  const loadGroups = async () => {
    setLoadingGroups(true);
    try {
      const result = await api.tg.groups();
      setGroups(result.groups);
    } finally {
      setLoadingGroups(false);
    }
  };

  useEffect(() => {
    if (step !== "group") return;
    void loadGroups();
  }, [step]);

  if (step === "login") {
    return <TgLoginCard onDone={async () => {
      const next = await refreshStatus();
      if (next.connected && !next.watchGroupId) {
        await loadGroups();
        setStep("group");
      }
    }} />;
  }

  if (step === "group") {
    return (
      <TgGroupCard
        groups={groups}
        onDone={async () => {
          await refreshStatus();
        }}
        onRelogin={async () => {
          await api.tg.disconnect().catch(() => undefined);
          const next = await refreshStatus().catch(() => null);
          if (!next?.connected) setStep("login");
        }}
      />
    );
  }

  return (
    <div className="rounded-2xl border border-[#252a3d] bg-[#161929] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-white font-semibold text-sm">TG 已连接</div>
          <div className="mt-1 text-xs text-slate-400">
            {tgStatus?.me?.firstName ?? ""} {tgStatus?.me?.username ? `@${tgStatus.me.username}` : ""}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            当前群组：{tgStatus?.watchGroupTitle ?? "未选择"}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              void loadGroups();
              setStep("group");
            }}
            disabled={loadingGroups}
            className="rounded-lg border border-[#252a3d] px-3 py-1.5 text-xs text-slate-300 hover:text-white disabled:opacity-40"
          >
            换群
          </button>
          <button
            onClick={() =>
              void (async () => {
                await api.tg.disconnect();
                const next = await refreshStatus().catch(() => null);
                if (!next?.connected) setStep("login");
              })()
            }
            className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs text-red-400 hover:text-red-300"
          >
            断开TG
          </button>
        </div>
      </div>
    </div>
  );
}
