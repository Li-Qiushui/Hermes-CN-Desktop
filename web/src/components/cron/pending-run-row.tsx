import { useEffect, useState } from "react";
import {
  PENDING_RUN_TIMEOUT_MS,
  formatElapsed,
  pendingRunElapsedSeconds,
} from "@/lib/cron-runs";
import s from "./cron-editor.module.css";

interface PendingRunRowProps {
  requestedAt: number;
}

export function PendingRunRow({ requestedAt }: PendingRunRowProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsed = pendingRunElapsedSeconds(requestedAt, now);
  const limit = Math.round(PENDING_RUN_TIMEOUT_MS / 1000);

  return (
    <div className={s.pendingRow} role="status" aria-live="polite" data-slot="cron-run-pending">
      <span className={s.spinner} aria-hidden="true" />
      <span className={s.pendingText}>
        <span className={s.pendingTitle}>排队中</span>
        <span className={s.pendingMeta}>已触发，等待调度器 tick 落地运行记录（上限 {limit} 秒）</span>
      </span>
      <span className={s.pendingElapsed}>已等待 {formatElapsed(elapsed)}</span>
    </div>
  );
}
