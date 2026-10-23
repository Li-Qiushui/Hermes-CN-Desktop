import { useEffect, useState } from "react";
import { AlertTriangle, Copy, PlugZap, X } from "lucide-react";
import {
  isKernelPortFallback,
  kernelEndpoint,
  retryKernel,
  type KernelStatusView,
} from "@/lib/kernel-status";
import s from "./kernel-port-fallback-notice.module.css";

const DISMISS_KEY = "hermes.kernelPortFallback.dismissed";

function readDismissed(): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(value: string | null) {
  try {
    if (typeof window === "undefined") return;
    if (value === null) window.sessionStorage.removeItem(DISMISS_KEY);
    else window.sessionStorage.setItem(DISMISS_KEY, value);
  } catch {
    return;
  }
}

export function KernelPortFallbackNotice({
  status,
}: {
  status: KernelStatusView | null | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());

  const fallback = isKernelPortFallback(status);

  useEffect(() => {
    if (fallback) return;
    writeDismissed(null);
    setDismissed(null);
  }, [fallback]);

  if (!fallback) return null;

  const baseUrl = (status?.baseUrl ?? "").trim();
  if (dismissed !== null && dismissed === baseUrl) return null;

  const endpoint = kernelEndpoint(status);

  const dismiss = () => {
    writeDismissed(baseUrl);
    setDismissed(baseUrl);
    setCopied(false);
    setRetryNote(null);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`内核地址 ${endpoint}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryNote(null);
    try {
      const next = await retryKernel();
      setRetryNote(
        next && !isKernelPortFallback(next)
          ? "已重新连上内核"
          : "还是连不上，重启桌面端才能恢复",
      );
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={s.notice} role="alert" data-testid="kernel-port-fallback-notice">
      <AlertTriangle size={16} aria-hidden="true" />
      <div className={s.copy}>
        <div className={s.heading}>内核已换到新端口</div>
        <div className={s.detail}>
          网络通道需要重启桌面端才能恢复。刚才重启内核时旧端口没抢回来，内核现在跑在
          <code>{endpoint}</code>
          ，消息收发会一直连不上。
        </div>
        {retryNote ? <div className={s.note}>{retryNote}</div> : null}
      </div>
      <div className={s.actions}>
        <button type="button" onClick={() => void retry()} disabled={retrying} data-testid="kernel-port-fallback-retry">
          <PlugZap size={12} aria-hidden="true" />
          <span>{retrying ? "重连中" : "重试连接"}</span>
        </button>
        <button type="button" onClick={() => void copy()} data-testid="kernel-port-fallback-copy">
          <Copy size={12} aria-hidden="true" />
          <span>{copied ? "已复制" : "复制地址"}</span>
        </button>
        <button
          type="button"
          className={s.iconButton}
          onClick={dismiss}
          aria-label="关闭提示，重启桌面端后会再出现"
          title="本次先关掉，重启桌面端后会再提示"
          data-testid="kernel-port-fallback-dismiss"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
