import { useCallback, useState } from "react";
import { Check, Copy, FolderOpen, KeyRound, RotateCcw, Wifi } from "lucide-react";
import { classifyGatewayError } from "@/lib/gateway-result";
import type { ChatMessage } from "./chat-types";
import s from "./error-recovery-actions.module.css";

const LOG_PATH_PATTERN = /(?:[A-Za-z]:[\\/][^\s"'<>]+|\/(?:[\w.-]+\/)+[\w.-]+)\.(?:log|jsonl|ndjson|txt)/;

export function resolveErrorDisplayText(text: string): string {
  const info = classifyGatewayError(text);
  if (info.kind === "unsupported-method") return info.message;
  return text;
}

export function errorLogPath(text: string): string | null {
  const matched = LOG_PATH_PATTERN.exec(text);
  return matched ? matched[0] : null;
}

export interface ErrorRecoveryActionsProps {
  text: string;
  retrySource?: ChatMessage | null;
  onRetry?: (userMessage: ChatMessage) => void;
  locked?: boolean;
  lockedReason?: string;
  onOpenSettings?: (path: string) => void;
}

export function ErrorRecoveryActions({
  text,
  retrySource,
  onRetry,
  locked = false,
  lockedReason,
  onOpenSettings,
}: ErrorRecoveryActionsProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const info = classifyGatewayError(text);
  const logPath = errorLogPath(text);
  const canRetry = Boolean(retrySource && onRetry) && info.retryable;
  const needsConnection = info.kind === "network" || info.kind === "timeout";
  const needsAuth = info.kind === "auth";

  const copyDetails = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }, [text]);

  const openLog = useCallback(() => {
    if (!logPath) return;
    const bridge = window.hermesDesktop;
    if (bridge?.openWorkspacePath) {
      void bridge.openWorkspacePath({ path: logPath }).catch(() => undefined);
      return;
    }
    onOpenSettings?.("/logs");
  }, [logPath, onOpenSettings]);

  return (
    <div className={s.actions} data-error-actions="true">
      {canRetry ? (
        <button
          type="button"
          className={s.action}
          onClick={() => {
            if (retrySource) onRetry?.(retrySource);
          }}
          disabled={locked}
          title={locked ? (lockedReason ?? "正在生成回复，等这轮结束再重试") : "重发这条回复对应的提问"}
          data-error-action="retry"
        >
          <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>重试</span>
        </button>
      ) : null}
      <button
        type="button"
        className={s.action}
        onClick={() => void copyDetails()}
        title="把这条错误的原始信息复制走"
        data-error-action="copy"
        data-copy-state={copyState}
      >
        {copyState === "copied" ? (
          <Check size={13} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Copy size={13} strokeWidth={1.75} aria-hidden="true" />
        )}
        <span>{copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : "复制错误详情"}</span>
      </button>
      {logPath ? (
        <button
          type="button"
          className={s.action}
          onClick={openLog}
          title={logPath}
          data-error-action="open-log"
        >
          <FolderOpen size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>打开日志</span>
        </button>
      ) : null}
      {needsConnection ? (
        <button
          type="button"
          className={s.action}
          onClick={() => onOpenSettings?.("/connection")}
          title="到设置里的连接区检查内核地址与状态"
          data-error-action="check-connection"
        >
          <Wifi size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>检查连接</span>
        </button>
      ) : null}
      {needsAuth ? (
        <button
          type="button"
          className={s.action}
          onClick={() => onOpenSettings?.("/models")}
          title="到模型配置里检查 API Key"
          data-error-action="check-api-key"
        >
          <KeyRound size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>检查 API Key</span>
        </button>
      ) : null}
    </div>
  );
}
