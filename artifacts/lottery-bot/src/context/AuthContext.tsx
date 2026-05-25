import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { api, type AuthUser, type CardStatus } from "../lib/api";

function calcCountdown(expiresAt: string): string | null {
  const remaining = new Date(expiresAt).getTime() - Date.now();
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
  const [countdown, setCountdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const expiredFiredRef = useRef(false);

  const logout = useCallback(async () => {
    await api.auth.logout();
    setUser(null);
    setCard(null);
    setCountdown(null);
  }, []);

  const refreshCard = useCallback(async () => {
    if (!user) { setCard(null); return; }
    try {
      const status = await api.card.status();
      setCard(status);
    } catch {
      setCard({ active: false });
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
    else setCard(null);
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
      const cd = calcCountdown(card.expiresAt!);
      if (cd === null) {
        expiredFiredRef.current = true;
        setCountdown("已到期");
        void (async () => {
          try { await api.tg.disconnect(); } catch { /* may already be gone */ }
          await logout();
        })();
        return;
      }
      setCountdown(cd);
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [card, logout]);

  const login = async (username: string, password: string) => {
    const { user: me } = await api.auth.login(username, password);
    setUser(me);
  };

  const register = async (username: string, password: string) => {
    const { user: me } = await api.auth.register(username, password);
    setUser(me);
  };

  return (
    <AuthContext.Provider value={{ user, card, countdown, loading, login, register, logout, refreshCard }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
