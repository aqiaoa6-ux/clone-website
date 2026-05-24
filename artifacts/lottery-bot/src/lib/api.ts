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
  totalBets?: number;
  settled?: number;
  wins?: number;
  maxStreak?: number;
  winRate?: string;
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
