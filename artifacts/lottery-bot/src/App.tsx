import { Router as WouterRouter } from "wouter";
import { AuthProvider } from "./context/AuthContext";
import AppRoutes from "./AppRoutes";

export default function App() {
  return (
    <AuthProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <AppRoutes />
      </WouterRouter>
    </AuthProvider>
  );
}
