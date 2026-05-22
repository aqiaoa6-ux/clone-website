import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2, CheckCircle2, Users, Link } from 'lucide-react';

interface GroupInfo {
  id: string;
  title: string;
  type: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onGroupSet: (group: GroupInfo) => void;
  currentGroupId?: string;
}

export default function GroupSetupModal({ isOpen, onClose, onGroupSet, currentGroupId }: Props) {
  const [groupLink, setGroupLink] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [error, setError] = useState('');
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [tab, setTab] = useState<'link' | 'list'>('link');

  useEffect(() => {
    if (isOpen) {
      loadGroups();
    }
  }, [isOpen]);

  async function loadGroups() {
    setLoadingGroups(true);
    try {
      const res = await fetch('/api/tg/groups');
      if (!res.ok) return;
      const data = await res.json() as { groups: GroupInfo[] };
      setGroups(data.groups ?? []);
    } catch { /* silent */ }
    finally { setLoadingGroups(false); }
  }

  async function handleSetByLink() {
    const raw = groupLink.trim();
    if (!raw) { setError('请输入群链接'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/tg/resolve-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link: raw }),
      });
      const data = await res.json() as { ok?: boolean; group?: GroupInfo; error?: string };
      if (!res.ok || !data.ok) { setError(data.error ?? '群链接无效'); return; }
      await applyGroup(data.group!);
    } catch { setError('网络错误，请重试'); }
    finally { setLoading(false); }
  }

  async function handleSelectGroup(group: GroupInfo) {
    setLoading(true);
    try {
      await applyGroup(group);
    } finally { setLoading(false); }
  }

  async function applyGroup(group: GroupInfo) {
    await fetch('/api/tg/set-group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: group.id }),
    });
    onGroupSet(group);
    onClose();
    setGroupLink('');
  }

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
            className="fixed z-50 inset-x-4 max-w-[420px] mx-auto top-1/2 -translate-y-1/2 bg-[#1e2438] border border-[#2d3654] rounded-2xl shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[#2d3654]/70">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-[#3b5de7]/20 flex items-center justify-center">
                  <Users className="w-3.5 h-3.5 text-[#4CA2FF]" />
                </div>
                <span className="text-white font-semibold text-sm">设置投注群</span>
              </div>
              <button onClick={onClose} className="text-muted-foreground hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-[#2d3654]/70">
              <button
                onClick={() => setTab('link')}
                className={`flex-1 py-2.5 text-xs font-medium transition-colors ${tab === 'link' ? 'text-white border-b-2 border-[#3b5de7]' : 'text-muted-foreground'}`}
              >
                输入群链接
              </button>
              <button
                onClick={() => setTab('list')}
                className={`flex-1 py-2.5 text-xs font-medium transition-colors ${tab === 'list' ? 'text-white border-b-2 border-[#3b5de7]' : 'text-muted-foreground'}`}
              >
                从群列表选择
              </button>
            </div>

            <div className="p-5">
              <AnimatePresence mode="wait">
                {tab === 'link' && (
                  <motion.div key="link" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <p className="text-muted-foreground text-xs mb-4 leading-relaxed">
                      输入 Telegram 群/频道链接（如 <span className="text-[#4CA2FF]">t.me/groupname</span> 或 <span className="text-[#4CA2FF]">@groupname</span>）
                    </p>
                    <div className="relative mb-1">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        <Link className="w-3.5 h-3.5" />
                      </div>
                      <input
                        type="text"
                        value={groupLink}
                        onChange={e => { setGroupLink(e.target.value); setError(''); }}
                        onKeyDown={e => e.key === 'Enter' && handleSetByLink()}
                        placeholder="t.me/groupname 或 @groupname"
                        className="w-full bg-[#151a26] border border-[#2d3654] focus:border-[#3b5de7] rounded-lg pl-9 pr-3 py-2.5 text-white text-sm outline-none transition-colors placeholder:text-muted-foreground/40"
                        autoFocus
                        data-testid="input-group-link"
                      />
                    </div>
                    {error && <p className="text-[#f44336] text-xs mt-1.5">{error}</p>}
                    <button
                      onClick={handleSetByLink}
                      disabled={loading || !groupLink.trim()}
                      className="mt-4 w-full bg-[#3b5de7] hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg py-2.5 text-sm font-medium transition-colors flex items-center justify-center gap-2"
                      data-testid="button-set-group-link"
                    >
                      {loading ? <><Loader2 className="w-4 h-4 animate-spin" />设置中...</> : '确认设置'}
                    </button>
                  </motion.div>
                )}

                {tab === 'list' && (
                  <motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    {loadingGroups ? (
                      <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground text-sm">
                        <Loader2 className="w-4 h-4 animate-spin" />加载群列表...
                      </div>
                    ) : groups.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground text-sm">
                        暂无群组，请先加入群后重试
                      </div>
                    ) : (
                      <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                        {groups.map(g => (
                          <button
                            key={g.id}
                            onClick={() => handleSelectGroup(g)}
                            disabled={loading}
                            className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors text-left ${
                              currentGroupId === g.id
                                ? 'bg-[#3b5de7]/20 border border-[#3b5de7]/50'
                                : 'bg-[#151a26] hover:bg-[#2d3654]/50 border border-transparent'
                            }`}
                            data-testid={`button-group-${g.id}`}
                          >
                            <div className="w-8 h-8 rounded-full bg-[#2d3654] flex items-center justify-center flex-shrink-0">
                              <Users className="w-4 h-4 text-[#4CA2FF]" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-white text-xs font-medium truncate">{g.title}</div>
                              <div className="text-muted-foreground text-[10px]">
                                {g.type === 'channel' ? '频道' : '群组'}
                              </div>
                            </div>
                            {currentGroupId === g.id && <CheckCircle2 className="w-4 h-4 text-[#3b5de7] flex-shrink-0" />}
                          </button>
                        ))}
                      </div>
                    )}
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
