import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { useKernelStatus } from "@/hooks/use-kernel-status";
import { useStatus } from "@/hooks/use-status";
import { useSessions } from "@/hooks/use-sessions";
import { useAnalytics } from "@/hooks/use-analytics";
import { useRuntimeInfo } from "@/hooks/use-runtime-update";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { isKernelDegraded } from "@/lib/kernel-status";
import { isSessionRunning, mergeLiveRuntimeSessions } from "@/lib/session-activity";
import { formatTokens } from "@/lib/format";
import { buildSidebarVersionRows } from "./sidebar-version-tag";
import { KernelDegradedStat } from "./kernel-degraded-stat";
import s from "./app-status-bar.module.css";

export function AppStatusBar() {
  const { data: status } = useStatus();
  const { data: sessions } = useSessions(20);
  const { data: analytics } = useAnalytics(1);
  const { data: runtimeInfo } = useRuntimeInfo();
  const { data: kernelStatus } = useKernelStatus();
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);

  const kernelDegraded = isKernelDegraded(kernelStatus);
  const versionRows = buildSidebarVersionRows({ status, runtimeInfo });

  const runningCount = useMemo(() => {
    const merged = mergeLiveRuntimeSessions(sessions?.sessions ?? [], runtimeBySession);
    const localCount = merged.filter((sess) => isSessionRunning(sess, runtimeBySession)).length;
    if (sessions?.sessions) return localCount;
    return Math.max(localCount, status?.active_sessions ?? 0);
  }, [sessions, runtimeBySession, status?.active_sessions]);

  const errorsLast24h = useMemo(() => {
    if (!sessions?.sessions) return 0;
    const cutoff = Date.now() / 1000 - 24 * 3600;
    return sessions.sessions.filter(
      (sess) =>
        sess.ended_at != null &&
        sess.ended_at >= cutoff &&
        (sess.end_reason === "error" || sess.end_reason === "interrupted"),
    ).length;
  }, [sessions]);

  const todayTokens =
    (analytics?.daily?.[0]?.input_tokens ?? 0) + (analytics?.daily?.[0]?.output_tokens ?? 0);

  return (
    <footer className={s.statusbar} aria-label="运行状态">
      {kernelDegraded && (
        <>
          <KernelDegradedStat status={kernelStatus} />
          <span className={s.sep} />
        </>
      )}
      <span className={s.stat} data-prio="2" title={versionRows.kernel}>
        <span className={s.lbl}>内核</span>
        <span className={s.val}>{versionRows.kernelLine.version}</span>
        <span className={s.val}>{versionRows.kernelLine.commit}</span>
      </span>
      <span className={s.sep} />
      <span className={s.stat} data-prio="3" title={versionRows.ui}>
        <span className={s.lbl}>界面</span>
        <span className={s.val}>{versionRows.uiLine.version}</span>
        <span className={s.val}>{versionRows.uiLine.commit}</span>
      </span>

      <div className={s.right}>
        <span className={s.stat} data-prio="1">
          <span className={s.lbl}>进行中</span>
          <span className={s.val}>{runningCount}</span>
        </span>
        <span className={s.sep} />
        <span className={s.stat} data-prio="2" data-tone={errorsLast24h > 0 ? "warn" : undefined}>
          <span className={s.lbl}>24H 错误</span>
          <span className={s.val}>{errorsLast24h}</span>
        </span>
        <span className={s.sep} />
        <span className={s.stat} data-prio="3">
          <span className={s.lbl}>今日 Tokens</span>
          <span className={s.val}>{formatTokens(todayTokens)}</span>
        </span>
      </div>
    </footer>
  );
}
