import { Route, Switch, Redirect } from "wouter";
import { useAuth } from "./context/AuthContext";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import CardKeyPage from "./pages/CardKeyPage";
import Dashboard from "./pages/Dashboard";
import AdminPage from "./pages/AdminPage";
import TrendPage from "./pages/TrendPage";

function ProtectedRoute({ children, requireCard = true, requireAdmin = false }: {
  children: React.ReactNode;
  requireCard?: boolean;
  requireAdmin?: boolean;
}) {
  const { user, card, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b0e1a] flex items-center justify-center">
        <div className="text-slate-500 text-sm">加载中...</div>
      </div>
    );
  }

  if (!user) return <Redirect to="/login" />;
  if (requireAdmin && !user.isAdmin) return <Redirect to="/" />;
  // Admins bypass card requirement — they need to access /admin to generate keys
  if (requireCard && !card?.active && !user.isAdmin) return <Redirect to="/card-key" />;

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, card, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b0e1a] flex items-center justify-center">
        <div className="text-slate-500 text-sm">加载中...</div>
      </div>
    );
  }

  if (user) {
    // Admins go straight to dashboard (they don't need a card)
    if (user.isAdmin) return <Redirect to="/" />;
    if (!card?.active) return <Redirect to="/card-key" />;
    return <Redirect to="/" />;
  }

  return <>{children}</>;
}

export default function AppRoutes() {
  return (
    <Switch>
      <Route path="/login">
        <PublicRoute><LoginPage /></PublicRoute>
      </Route>
      <Route path="/register">
        <PublicRoute><RegisterPage /></PublicRoute>
      </Route>
      <Route path="/card-key">
        <ProtectedRoute requireCard={false}>
          <CardKeyPage />
        </ProtectedRoute>
      </Route>
      <Route path="/admin">
        <ProtectedRoute requireAdmin>
          <AdminPage />
        </ProtectedRoute>
      </Route>
      <Route path="/trend">
        <ProtectedRoute requireCard={false}>
          <TrendPage />
        </ProtectedRoute>
      </Route>
      <Route path="/">
        <ProtectedRoute>
          <Dashboard />
        </ProtectedRoute>
      </Route>
      <Route>
        <Redirect to="/" />
      </Route>
    </Switch>
  );
}
