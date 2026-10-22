import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { formatRunClock } from "@/lib/kanban";

export interface RunClockProps {
  startedAt: number | null | undefined;
  className?: string;
}

export function RunClock({ startedAt, className }: RunClockProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) return null;

  return (
    <span className={className} data-run-clock="true" aria-label={`本次运行 ${formatRunClock(startedAt, nowMs)}`}>
      <Timer size={13} aria-hidden="true" />
      {formatRunClock(startedAt, nowMs)}
    </span>
  );
}
