import { useState } from "react";
import BottomNav from "../components/BottomNav";

interface Step {
  num: number;
  title: string;
  icon: string;
  content: React.ReactNode;
}

const steps: Step[] = [
  {
    num: 1,
    title: "注册账号",
    icon: "👤",
    content: (
      <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
        <p>打开平台后，点击登录页底部的 <span className="text-blue-400 font-medium">「立即注册」</span> 按钮。</p>
        <div className="bg-[#0f1220] border border-[#252a3d] rounded-xl p-3 space-y-1.5">
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">①</span>
            <span>输入想要使用的<span className="text-white font-medium">用户名</span>（英文或中文均可）</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">②</span>
            <span>输入<span className="text-white font-medium">密码</span>（建议6位以上）</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">③</span>
            <span>再次输入密码确认，点击<span className="text-white font-medium">注册</span></span>
          </div>
        </div>
      </div>
    ),
  },
  {
    num: 2,
    title: "登录账号",
    icon: "🔐",
    content: (
      <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
        <p>注册完成后回到登录页，输入账号密码即可登录。</p>
        <div className="bg-[#0f1220] border border-[#252a3d] rounded-xl p-3 space-y-1.5">
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">①</span>
            <span>输入用户名和密码</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">②</span>
            <span>勾选 <span className="text-white font-medium">「记住密码」</span> 可下次自动填入</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">③</span>
            <span>点击 <span className="text-white font-medium">「登 录」</span></span>
          </div>
        </div>
      </div>
    ),
  },
  {
    num: 3,
    title: "激活卡密",
    icon: "🎫",
    content: (
      <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
        <p>登录后需要激活<span className="text-white font-medium">卡密</span>才能使用投注功能。联系管理员获取卡密。</p>
        <div className="bg-[#0f1220] border border-[#252a3d] rounded-xl p-3 space-y-1.5">
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">①</span>
            <span>点击底部导航 <span className="text-white font-medium">「卡密」</span></span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">②</span>
            <span>在输入框粘贴卡密（格式：<span className="font-mono text-green-400 text-xs">XXXX-XXXX-XXXX-XXXX</span>）</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">③</span>
            <span>点击 <span className="text-white font-medium">「激活卡密」</span>，激活成功后显示到期时间</span>
          </div>
        </div>
        <div className="bg-slate-500/10 border border-slate-500/30 rounded-xl px-3 py-2.5 flex gap-2">
          <span className="flex-shrink-0">💡</span>
          <span className="text-slate-400 text-xs">卡密分为天卡（1天）、周卡（7天）、月卡（30天）。到期前可续费激活新卡密。</span>
        </div>
      </div>
    ),
  },
  {
    num: 4,
    title: "连接 Telegram",
    icon: "✈️",
    content: (
      <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
        <p>激活卡密后，返回 <span className="text-white font-medium">主控台</span> 连接你的 Telegram 账号。</p>
        <div className="bg-[#0f1220] border border-[#252a3d] rounded-xl p-3 space-y-1.5">
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">①</span>
            <span>输入手机号（含国家码，如 <span className="font-mono text-green-400 text-xs">+8613800001234</span>）</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">②</span>
            <span>Telegram 会发送验证码到你的手机，输入验证码</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">③</span>
            <span>如开启了两步验证，还需输入密码</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">④</span>
            <span>连接成功后进入<span className="text-white font-medium">群组选择</span>，选择要监听和投注的群组</span>
          </div>
        </div>
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-3 py-2.5 flex gap-2">
          <span className="text-yellow-400 flex-shrink-0">⚠️</span>
          <span className="text-yellow-300 text-xs">请确保你的 Telegram 账号已在该投注群组中，否则无法发送投注消息。</span>
        </div>
      </div>
    ),
  },
  {
    num: 5,
    title: "配置投注参数",
    icon: "⚙️",
    content: (
      <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
        <p>连接成功后，点击右上角 <span className="text-white font-medium">「设置」</span> 按钮配置投注参数。</p>
        <div className="bg-[#0f1220] border border-[#252a3d] rounded-xl p-3 space-y-2">
          <div className="text-xs text-slate-500 font-medium mb-1">主要参数说明</div>
          <div className="flex justify-between items-start border-b border-[#252a3d] pb-1.5">
            <span className="text-white text-xs font-medium w-20 flex-shrink-0">游戏模式</span>
            <span className="text-slate-400 text-xs">加拿大或快三，根据投注群选择</span>
          </div>
          <div className="flex justify-between items-start border-b border-[#252a3d] pb-1.5">
            <span className="text-white text-xs font-medium w-20 flex-shrink-0">每注金额</span>
            <span className="text-slate-400 text-xs">每次下注的基础金额</span>
          </div>
          <div className="flex justify-between items-start border-b border-[#252a3d] pb-1.5">
            <span className="text-white text-xs font-medium w-20 flex-shrink-0">投注策略</span>
            <span className="text-slate-400 text-xs">固定/马丁（输了倍投）/反马丁（赢了倍投）</span>
          </div>
          <div className="flex justify-between items-start border-b border-[#252a3d] pb-1.5">
            <span className="text-white text-xs font-medium w-20 flex-shrink-0">止损</span>
            <span className="text-slate-400 text-xs">亏损达到该金额后自动停止，0为不限制</span>
          </div>
          <div className="flex justify-between items-start">
            <span className="text-white text-xs font-medium w-20 flex-shrink-0">止盈</span>
            <span className="text-slate-400 text-xs">盈利达到该金额后自动停止，0为不限制</span>
          </div>
        </div>
        <div className="bg-slate-500/10 border border-slate-500/30 rounded-xl px-3 py-2.5 flex gap-2">
          <span className="flex-shrink-0">💡</span>
          <span className="text-slate-400 text-xs">新手建议先用小金额测试，熟悉系统后再调整。</span>
        </div>
      </div>
    ),
  },
  {
    num: 6,
    title: "选择投注算法",
    icon: "🧠",
    content: (
      <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
        <p>在设置中可以选择一个或多个<span className="text-white font-medium">算法</span>，系统会轮流使用。</p>
        <div className="bg-[#0f1220] border border-[#252a3d] rounded-xl p-3 space-y-2">
          <div className="space-y-2">
            {[
              { name: "跟信号", desc: "根据群内信号消息方向下注" },
              { name: "反信号", desc: "与信号方向相反下注" },
              { name: "连出跟随", desc: "连续出现相同结果时跟注" },
              { name: "AI趋势", desc: "AI分析历史规律自动决策" },
              { name: "快三-跟上期", desc: "押上一局相同方向（快三专用）" },
              { name: "快三-AABB", desc: "两期相同则顺，不同则反（快三）" },
            ].map(a => (
              <div key={a.name} className="flex gap-2 border-b border-[#252a3d] pb-1.5 last:border-0 last:pb-0">
                <span className="text-blue-400 text-xs font-medium w-24 flex-shrink-0">{a.name}</span>
                <span className="text-slate-400 text-xs">{a.desc}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-slate-500/10 border border-slate-500/30 rounded-xl px-3 py-2.5 flex gap-2">
          <span className="flex-shrink-0">💡</span>
          <span className="text-slate-400 text-xs">可同时选多个算法，系统轮流切换使用，分散风险。</span>
        </div>
      </div>
    ),
  },
  {
    num: 7,
    title: "开启自动投注",
    icon: "🚀",
    content: (
      <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
        <p>参数设置完成后，回到主控台开启自动投注。</p>
        <div className="bg-[#0f1220] border border-[#252a3d] rounded-xl p-3 space-y-1.5">
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">①</span>
            <span>点击 <span className="text-white font-medium">「开启自动投注」</span> 绿色按钮</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">②</span>
            <span>按钮变为 <span className="text-red-400 font-medium">「停止投注」</span> 表示已开启</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">③</span>
            <span>系统会在每期开放时自动下注，实时显示投注记录</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-blue-400 font-bold flex-shrink-0">④</span>
            <span>随时点击 <span className="text-red-400 font-medium">「停止投注」</span> 可暂停</span>
          </div>
        </div>
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-3 py-2.5 flex gap-2">
          <span className="text-emerald-400 flex-shrink-0">✅</span>
          <span className="text-emerald-300 text-xs">系统会实时推送开奖结果和余额变化，无需手动刷新。</span>
        </div>
      </div>
    ),
  },
  {
    num: 8,
    title: "查看走势与记录",
    icon: "📊",
    content: (
      <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
        <p>点击底部导航可查看更多功能：</p>
        <div className="bg-[#0f1220] border border-[#252a3d] rounded-xl p-3 space-y-2">
          <div className="flex gap-3 items-start border-b border-[#252a3d] pb-2">
            <span className="text-xl leading-none">📊</span>
            <div>
              <div className="text-white text-xs font-medium">走势图</div>
              <div className="text-slate-400 text-xs mt-0.5">查看历史开奖数据和大小单双分布，辅助判断规律</div>
            </div>
          </div>
          <div className="flex gap-3 items-start border-b border-[#252a3d] pb-2">
            <span className="text-xl leading-none">🎫</span>
            <div>
              <div className="text-white text-xs font-medium">卡密管理</div>
              <div className="text-slate-400 text-xs mt-0.5">查看当前卡密到期时间，激活新卡密续费</div>
            </div>
          </div>
          <div className="flex gap-3 items-start">
            <span className="text-xl leading-none">🏠</span>
            <div>
              <div className="text-white text-xs font-medium">主控台投注记录</div>
              <div className="text-slate-400 text-xs mt-0.5">实时显示每笔投注的结果、盈亏，支持一键清除</div>
            </div>
          </div>
        </div>
      </div>
    ),
  },
];

export default function TutorialPage() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="min-h-screen bg-[#0b0e1a] text-white pb-24">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-[#0b0e1a]/95 border-b border-[#1e2235] backdrop-blur">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center gap-3">
          <span className="text-xl">📖</span>
          <div>
            <h1 className="font-bold text-white text-sm">新手教程</h1>
            <p className="text-slate-500 text-[11px]">从注册到自动投注，全步骤指引</p>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 pt-4 space-y-2">
        {/* Progress bar */}
        <div className="bg-[#161929] border border-[#252a3d] rounded-2xl p-4 mb-2">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs text-slate-400">共 {steps.length} 个步骤</span>
            <span className="text-xs text-blue-400">点击展开查看</span>
          </div>
          <div className="flex gap-1">
            {steps.map(s => (
              <div
                key={s.num}
                onClick={() => setOpen(open === s.num - 1 ? null : s.num - 1)}
                className={`h-1.5 flex-1 rounded-full cursor-pointer transition ${open === s.num - 1 ? "bg-blue-500" : "bg-[#252a3d] hover:bg-[#353a52]"}`}
              />
            ))}
          </div>
        </div>

        {/* Steps */}
        {steps.map((step, idx) => (
          <div
            key={step.num}
            className={`bg-[#161929] border rounded-2xl overflow-hidden transition-all ${open === idx ? "border-blue-500/40" : "border-[#252a3d]"}`}
          >
            {/* Step header */}
            <button
              className="w-full flex items-center gap-3 px-4 py-3.5 text-left"
              onClick={() => setOpen(open === idx ? null : idx)}
            >
              <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 text-sm font-bold transition
                ${open === idx ? "bg-blue-600 text-white" : "bg-[#0f1220] text-slate-500 border border-[#252a3d]"}`}>
                {step.num}
              </div>
              <span className="text-lg leading-none flex-shrink-0">{step.icon}</span>
              <span className={`font-semibold text-sm flex-1 ${open === idx ? "text-white" : "text-slate-300"}`}>
                第 {step.num} 步：{step.title}
              </span>
              <span className={`text-slate-500 text-xs transition-transform ${open === idx ? "rotate-180" : ""}`}>▼</span>
            </button>

            {/* Step content */}
            {open === idx && (
              <div className="px-4 pb-4 border-t border-[#252a3d] pt-3">
                {step.content}
                <div className="flex gap-2 mt-4">
                  {idx > 0 && (
                    <button
                      onClick={() => setOpen(idx - 1)}
                      className="flex-1 py-2 text-xs text-slate-400 border border-[#252a3d] rounded-xl hover:border-slate-500 transition"
                    >
                      ← 上一步
                    </button>
                  )}
                  {idx < steps.length - 1 && (
                    <button
                      onClick={() => setOpen(idx + 1)}
                      className="flex-1 py-2 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded-xl transition"
                    >
                      下一步 →
                    </button>
                  )}
                  {idx === steps.length - 1 && (
                    <div className="flex-1 py-2 text-xs text-center text-emerald-400 border border-emerald-500/30 rounded-xl bg-emerald-500/10">
                      🎉 教程完成！
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

      </div>

      <BottomNav />
    </div>
  );
}
