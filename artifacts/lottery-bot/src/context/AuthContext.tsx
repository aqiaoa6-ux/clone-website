import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, type AuthUser, type CardStatus } from "../lib/api";

interface AuthContextValue {
  user: AuthUser | null;
  card: CardStatus | null;
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
  const [loading, setLoading] = useState(true);

  const refreshCard = useCallback(async () => {
    if (!user) { setCard(null); return; }
    try {
      const status = await api.card.status();
      setCard(status);
    } catch {
      setCard({ active: false });
    }
  }, [user]);

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

  const login = async (username: string, password: string) => {
    const { user: me } = await api.auth.login(username, password);
    setUser(me);
  };

  const register = async (username: string, password: string) => {
    const { user: me } = await api.auth.register(username, password);
    setUser(me);
  };

  const logout = async () => {
    await api.auth.logout();
    setUser(null);
    setCard(null);
  };

  return (
    <AuthContext.Provider value={{ user, card, loading, login, register, logout, refreshCard }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
