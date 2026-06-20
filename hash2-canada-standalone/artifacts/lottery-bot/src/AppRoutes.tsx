import { Route, Switch, Redirect } from "wouter";
import { useAuth } from "./context/AuthContext";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import CardKeyPage from "./pages/CardKeyPage";
import Hash2Page from "./pages/Hash2Page";
import CanadaPage from "./pages/CanadaPage";
import Canada2Page from "./pages/Canada2Page";
import AdminPage from "./pages/AdminPage";

function ProtectedRoute({ children, requireCard = true, requireAdmin = false }: {
  children: React.ReactNode;
  requireCard?: boolean;
  requireAdmin?: boolean;
}) {
  const { user, card, loading, cardLoading } = useAuth();

  if (loading || (user && requireCard && cardLoading)) {
    return (
      <div className="min-h-screen bg-[#0b0e1a] flex items-center justify-center">
        <div className="text-slate-500 text-sm">加载中...</div>
      </div>
    );
  }

  if (!user) return <Redirect to="/login" />;

  if (requireAdmin && !user.isAdmin) return <Redirect to="/" />;
  if (requireCard && !card?.active) return <Redirect to="/card-key" />;
  if (requireAdmin) return <>{children}</>;

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, card, loading, cardLoading } = useAuth();

  if (loading || (user && cardLoading)) {
    return (
      <div className="min-h-screen bg-[#0b0e1a] flex items-center justify-center">
        <div className="text-slate-500 text-sm">加载中...</div>
      </div>
    );
  }

  if (user) {
    if (!card?.active) return <Redirect to="/card-key" />;
    return <Redirect to="/" />;
  }

  return <>{children}</>;
}

export default function AppRoutes() {
  return (
    <Switch>
      <Route path="/login">
        <LoginPage />
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
        <ProtectedRoute requireAdmin requireCard={false}>
          <AdminPage />
        </ProtectedRoute>
      </Route>
      <Route path="/hash2">
        <ProtectedRoute>
          <Hash2Page />
        </ProtectedRoute>
      </Route>
      <Route path="/canada">
        <ProtectedRoute>
          <CanadaPage />
        </ProtectedRoute>
      </Route>
      <Route path="/canada2">
        <ProtectedRoute>
          <Canada2Page />
        </ProtectedRoute>
      </Route>
      <Route path="/">
        <ProtectedRoute>
          <Redirect to="/hash2" />
        </ProtectedRoute>
      </Route>
      <Route>
        <Redirect to="/" />
      </Route>
    </Switch>
  );
}
