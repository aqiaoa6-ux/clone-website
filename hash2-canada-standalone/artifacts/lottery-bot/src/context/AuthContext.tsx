import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { api, setAuthToken, type AuthUser, type CardStatus } from "../lib/api";

interface AuthContextValue {
  user: AuthUser | null;
  card: CardStatus | null;
  cardLoading: boolean;
  serverOffsetMs: number;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshCard: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [card, setCard] = useState<CardStatus | null>(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const expiredFiredRef = useRef(false);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cardSignature = useCallback((status: CardStatus | null) => {
    if (!status) return "";
    return [
      status.active ? "1" : "0",
      status.expired ? "1" : "0",
      status.type ?? "",
      status.expiresAt ?? "",
      status.key ?? "",
      status.serverNow ?? "",
    ].join("|");
  }, []);

  const applyCardStatus = useCallback((status: CardStatus | null) => {
    if (status?.serverNow) {
      const nextOffset = new Date(status.serverNow).getTime() - Date.now();
      setServerOffsetMs(prev => (Math.abs(prev - nextOffset) > 1000 ? nextOffset : prev));
    }
    setCard(prev => (cardSignature(prev) === cardSignature(status) ? prev : status));
  }, [cardSignature]);

  const logout = useCallback(async () => {
    await api.auth.logout();
    setAuthToken(null);
    setUser(null);
    setCard(null);
    setCardLoading(false);
    setServerOffsetMs(0);
  }, []);

  const refreshCard = useCallback(async () => {
    if (!user) {
      setCard(prev => (prev ? null : prev));
      setCardLoading(false);
      return;
    }
    setCardLoading(true);
    try {
      const status = await api.card.status();
      applyCardStatus(status);
    } catch {
      setCard(prev => (prev ? null : prev));
    } finally {
      setCardLoading(false);
    }
  }, [applyCardStatus, user]);

  const refreshCardSilently = useCallback(async () => {
    if (!user) {
      setCard(prev => (prev ? null : prev));
      return;
    }
    try {
      const status = await api.card.status();
      applyCardStatus(status);
    } catch {
      setCard(prev => (prev ? null : prev));
    }
  }, [applyCardStatus, user]);

  // Bootstrap
  useEffect(() => {
    (async () => {
      try {
        const { user: me } = await api.auth.me();
        setUser(me);
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (user) void refreshCard();
    else {
      setCard(null);
      setCardLoading(false);
    }
  }, [user, refreshCard]);

  // Poll card status every 60s to stay in sync with server
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => { void refreshCardSilently(); }, 60_000);
    return () => clearInterval(id);
  }, [user, refreshCardSilently]);

  useEffect(() => {
    if (expiryTimerRef.current) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
    if (!card?.active || !card.expiresAt) {
      expiredFiredRef.current = false;
      return;
    }
    expiredFiredRef.current = false;

    const expiresAtMs = new Date(card.expiresAt!).getTime();
    const remaining = expiresAtMs - (Date.now() + serverOffsetMs);
    const ms = remaining <= 0 ? 0 : Math.min(remaining + 500, 2147483647);

    const onExpired = async () => {
      if (expiredFiredRef.current) return;
      expiredFiredRef.current = true;
      try {
        const status = await api.card.status();
        applyCardStatus(status);
        if (!status.active && status.expired) {
          try { await api.tg.disconnect(); } catch {}
        }
      } catch {}
    };

    if (ms === 0) {
      void onExpired();
      return;
    }
    expiryTimerRef.current = setTimeout(() => { void onExpired(); }, ms);
    return () => {
      if (expiryTimerRef.current) {
        clearTimeout(expiryTimerRef.current);
        expiryTimerRef.current = null;
      }
    };
  }, [applyCardStatus, card?.active, card?.expiresAt, serverOffsetMs, refreshCard]);

  const login = async (username: string, password: string) => {
    const { user: me, token } = await api.auth.login(username, password);
    setAuthToken(token);
    setUser(me);
    try {
      await api.auth.me();
    } catch {
      setAuthToken(null);
      setUser(null);
      throw new Error("登录态未保存，请用 https 打开页面，或检查浏览器是否禁用 Cookie");
    }
  };

  const register = async (username: string, password: string) => {
    const { user: me, token } = await api.auth.register(username, password);
    setAuthToken(token);
    setUser(me);
    try {
      await api.auth.me();
    } catch {
      setAuthToken(null);
      setUser(null);
      throw new Error("注册成功但登录态未保存，请用 https 打开页面，或检查浏览器是否禁用 Cookie");
    }
  };

  return (
    <AuthContext.Provider value={{ user, card, cardLoading, serverOffsetMs, loading, login, register, logout, refreshCard }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
