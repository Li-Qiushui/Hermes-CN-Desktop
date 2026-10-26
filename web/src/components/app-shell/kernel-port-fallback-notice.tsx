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
const HEALTH_TIMEOUT_MS = 2500;
const RECHECK_FAST_MS = 2000;
const RECHECK_SLOW_MS = 6000;

export async function kernelEndpointAnswers(
  baseUrl: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  const target = baseUrl.trim().replace(/\/+$/, "");
  if (!target || typeof fetch !== "function") return false;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(`${target}/api/health`, {
      signal: controller?.signal,
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

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
  checkEndpoint = kernelEndpointAnswers,
}: {
  status: KernelStatusView | null | undefined;
  checkEndpoint?: (baseUrl: string) => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());
  const [health, setHealth] = useState<{ endpoint: string; ok: boolean } | null>(null);

  const fallback = isKernelPortFallback(status);
  const baseUrl = (status?.baseUrl ?? "").trim();

  useEffect(() => {
    if (fallback) return;
    writeDismissed(null);
    setDismissed(null);
  }, [fallback]);

  useEffect(() => {
    if (!fallback || !baseUrl) {
      setHealth(null);
      return;
    }
    let cancelled = false;
    let timer = 0;
    let attempts = 0;
    const check = async () => {
      const ok = await checkEndpoint(baseUrl);
      if (cancelled) return;
      setHealth({ endpoint: baseUrl, ok });
      if (ok) return;
      attempts += 1;
      timer = window.setTimeout(
        () => void check(),
        attempts < 3 ? RECHECK_FAST_MS : RECHECK_SLOW_MS,
      );
    };
    void check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [baseUrl, checkEndpoint, fallback]);

  if (!fallback) return null;

  const reachable = health && health.endpoint === baseUrl ? health.ok : null;
  if (reachable === true) return null;
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
      if (next && isKernelPortFallback(next)) {
        setRetryNote("还是连不上，重启桌面端才能恢复");
        return;
      }
      setRetryNote("已重新连上内核");
      setHealth({ endpoint: baseUrl, ok: true });
    } finally {
      setRetrying(false);
    }
  };

  const failed = reachable === false;

  return (
    <div className={s.notice} role="alert" data-testid="kernel-port-fallback-notice">
      <AlertTriangle size={16} aria-hidden="true" />
      <div className={s.copy}>
        <div className={s.heading}>
          {failed ? "内核换了端口，还没连上" : "内核换了端口，已自动重连"}
        </div>
        <div className={s.detail}>
          {failed ? "桌面端已把接口地址切到" : "桌面端已按新地址"}
          <code>{endpoint}</code>
          {failed
            ? "，正在重试；一直连不上的话再重启桌面端。"
            : "重新建立连接，连上后这条提示会自动消失。"}
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
