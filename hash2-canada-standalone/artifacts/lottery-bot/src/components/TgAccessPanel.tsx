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
    <div className="rounded-2xl border border-[#252a3d] bg-[#161929] p-4">
      <div className="text-white font-semibold text-sm mb-3">TG 登录</div>
      {error && (
        <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {step === "phone" && (
        <div className="space-y-3">
          <input
            type="tel"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="+8613800001234"
            className="w-full rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2 text-sm text-white placeholder-slate-600"
          />
          <button
            disabled={loading || !phone.trim()}
            onClick={() =>
              void send(async () => {
                await api.tg.sendCode(phone.trim());
                setStep("code");
              })
            }
            className="w-full rounded-xl bg-blue-600 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {loading ? "发送中..." : "发送验证码"}
          </button>
        </div>
      )}

      {step === "code" && (
        <div className="space-y-3">
          <div className="text-xs text-slate-400">验证码已发送到 {phone}</div>
          <input
            type="text"
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="请输入验证码"
            className="w-full rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2 text-sm text-white placeholder-slate-600"
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
            className="w-full rounded-xl bg-blue-600 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {loading ? "验证中..." : "验证"}
          </button>
          <button
            onClick={() => setStep("phone")}
            className="w-full text-xs text-slate-500 hover:text-slate-300"
          >
            重新输入手机号
          </button>
        </div>
      )}

      {step === "password" && (
        <div className="space-y-3">
          <div className="text-xs text-slate-400">需要二步验证密码</div>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="请输入二步验证密码"
            className="w-full rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2 text-sm text-white placeholder-slate-600"
          />
          <button
            disabled={loading || !password.trim()}
            onClick={() =>
              void send(async () => {
                await api.tg.verifyPassword(password.trim());
                await onDone();
              })
            }
            className="w-full rounded-xl bg-blue-600 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {loading ? "验证中..." : "确认登录"}
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
    <div className="rounded-2xl border border-[#252a3d] bg-[#161929] p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="text-white font-semibold text-sm">选择投注群组</div>
        <button onClick={() => void onRelogin()} className="text-xs text-red-400 hover:text-red-300">
          重新登录TG
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={link}
          onChange={e => setLink(e.target.value)}
          placeholder="粘贴 t.me 群链接"
          className="flex-1 rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2 text-sm text-white placeholder-slate-600"
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
          className="rounded-xl bg-blue-600 px-4 text-sm text-white disabled:opacity-40"
        >
          搜索
        </button>
      </div>

      <input
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="搜索已加入群组"
        className="mb-3 w-full rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-2 text-sm text-white placeholder-slate-600"
      />

      <div className="max-h-56 space-y-2 overflow-y-auto">
        {filteredGroups.length === 0 && (
          <div className="rounded-xl border border-dashed border-[#252a3d] px-3 py-4 text-center text-xs text-slate-500">
            暂无可选群组，请先把 TG 账号加入目标群
          </div>
        )}
        {filteredGroups.map(group => (
          <button
            key={group.id}
            disabled={loading}
            onClick={() => void selectGroup(group.id)}
            className="w-full rounded-xl border border-[#252a3d] bg-[#0f1220] px-3 py-3 text-left hover:border-blue-500/40"
          >
            <div className="text-sm text-white">{group.title}</div>
            <div className="mt-1 text-[10px] text-slate-500">{group.type}</div>
          </button>
        ))}
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
