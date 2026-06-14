import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { api, setAuthToken, type AuthUser, type CardStatus } from "../lib/api";

function calcCountdown(expiresAt: string, nowMs: number): string | null {
  const remaining = new Date(expiresAt).getTime() - nowMs;
  if (remaining <= 0) return null;
  const d = Math.floor(remaining / 86400000);
  const h = Math.floor((remaining % 86400000) / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  if (d > 0) return `${d}天 ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface AuthContextValue {
  user: AuthUser | null;
  card: CardStatus | null;
  cardLoading: boolean;
  countdown: string | null;
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
  const [countdown, setCountdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const expiredFiredRef = useRef(false);
  const serverOffsetRef = useRef(0);

  const logout = useCallback(async () => {
    await api.auth.logout();
    setAuthToken(null);
    setUser(null);
    setCard(null);
    setCardLoading(false);
    setCountdown(null);
  }, []);

  const refreshCard = useCallback(async () => {
    if (!user) {
      setCard(null);
      setCardLoading(false);
      return;
    }
    setCardLoading(true);
    try {
      const status = await api.card.status();
      if (status.serverNow) {
        serverOffsetRef.current = new Date(status.serverNow).getTime() - Date.now();
      }
      setCard(status);
    } catch {
      setCard(null);
    } finally {
      setCardLoading(false);
    }
  }, [user]);

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
    const id = setInterval(() => { void refreshCard(); }, 60_000);
    return () => clearInterval(id);
  }, [user, refreshCard]);

  // Countdown ticker — updates every second; enforces expiry automatically
  useEffect(() => {
    if (!card?.active || !card.expiresAt) {
      setCountdown(null);
      expiredFiredRef.current = false;
      return;
    }
    expiredFiredRef.current = false;

    const tick = () => {
      if (expiredFiredRef.current) return;
      const nowMs = Date.now() + serverOffsetRef.current;
      const cd = calcCountdown(card.expiresAt!, nowMs);
      if (cd === null) {
        void (async () => {
          try {
            const status = await api.card.status();
            if (status.serverNow) {
              serverOffsetRef.current = new Date(status.serverNow).getTime() - Date.now();
            }
            setCard(status);
            if (!status.active) {
              setCountdown(null);
              if (status.expired) {
                try { await api.tg.disconnect(); } catch {}
              }
              return;
            }
            const cd2 = status.expiresAt ? calcCountdown(status.expiresAt, Date.now() + serverOffsetRef.current) : null;
            setCountdown(cd2 ?? "00:00:00");
          } catch {
            setCountdown(null);
          }
        })();
        return;
      }
      setCountdown(prev => (prev === cd ? prev : cd));
    };

    tick();
    const id = window.setInterval(tick, 10_000);
    return () => {
      window.clearInterval(id);
    };
  }, [card, logout]);

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
    <AuthContext.Provider value={{ user, card, cardLoading, countdown, loading, login, register, logout, refreshCard }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
