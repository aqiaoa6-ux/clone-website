import { useEffect, useState } from "react";

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

export function useCardCountdown(expiresAt: string | undefined, serverOffsetMs: number): string | null {
  const [countdown, setCountdown] = useState<string | null>(null);

  useEffect(() => {
    if (!expiresAt) {
      setCountdown(null);
      return;
    }

    const tick = () => {
      const nowMs = Date.now() + serverOffsetMs;
      const cd = calcCountdown(expiresAt, nowMs);
      setCountdown(prev => (prev === cd ? prev : cd));
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, serverOffsetMs]);

  return countdown;
}

