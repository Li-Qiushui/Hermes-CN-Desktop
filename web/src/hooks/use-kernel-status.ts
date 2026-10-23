import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { runtime } from "@/lib/runtime";
import {
  KERNEL_RETRY_QUERY_KEY,
  describeKernelRetry,
  retryKernelSync,
  syncKernelRuntime,
  type KernelRetryOutcome,
  type KernelRuntimeSync,
  type KernelStatusView,
} from "@/lib/kernel-status";

const KERNEL_MOVED_QUERY_KEYS = ["status", "sessions", "profiles", "desktop-runtime-info", "model-info"] as const;

async function recoverAfterKernelMove(): Promise<void> {
  const desktop = typeof window === "undefined" ? undefined : window.hermesDesktop;
  if (typeof desktop?.refreshGatewayUrl === "function") {
    await runtime.refreshGatewayUrl().catch(() => undefined);
  }
  await import("@/lib/gateway-client")
    .then(({ forceExistingGatewayReconnect }) => forceExistingGatewayReconnect("kernel-restart"))
    .catch(() => undefined);
  await Promise.allSettled(
    KERNEL_MOVED_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
  );
}

function adoptKernelStatus(status: KernelStatusView): KernelRuntimeSync {
  const sync = syncKernelRuntime(status);
  if (sync.baseUrlChanged) void recoverAfterKernelMove();
  return sync;
}

export function useKernelStatus() {
  return useQuery<KernelStatusView>({
    queryKey: ["kernel-status"],
    queryFn: async () => {
      const next = await window.hermesDesktop!.kernelStatus!();
      adoptKernelStatus(next);
      return next;
    },
    enabled: typeof window !== "undefined" && runtime.platform !== "web" && Boolean(window.hermesDesktop?.kernelStatus),
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useKernelStatusSnapshot(refetchMs = 5_000) {
  const [status, setStatus] = useState<KernelStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    const read = window.hermesDesktop?.kernelStatus;
    if (!read) return;
    let cancelled = false;

    const load = () => {
      read()
        .then((next) => {
          if (cancelled) return;
          adoptKernelStatus(next);
          setStatus(next);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    };

    load();
    const timer = window.setInterval(load, refetchMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refetchMs, nonce]);

  return { status, error, refresh };
}

export interface KernelRetryMessage {
  tone: "ok" | "error";
  text: string;
}

export interface KernelRetryOptions {
  fallback?: () => Promise<void> | void;
  onRetried?: (status: KernelStatusView) => void;
}

export function useKernelRetry(options: KernelRetryOptions = {}) {
  const { fallback, onRetried } = options;
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState<KernelRetryMessage | null>(null);
  const busy = useRef(false);

  const retry = useCallback(async (): Promise<KernelRetryOutcome | null> => {
    if (busy.current) return null;
    busy.current = true;
    setRetrying(true);
    setMessage(null);
    try {
      const result = await retryKernelSync();
      const next = result ? result.status : null;
      if (!next) {
        if (fallback) await fallback();
        return null;
      }
      if (result?.sync.baseUrlChanged) await recoverAfterKernelMove();
      const outcome = describeKernelRetry(next);
      setMessage({ tone: outcome.ok ? "ok" : "error", text: outcome.text });
      onRetried?.(next);
      await queryClient.invalidateQueries({ queryKey: KERNEL_RETRY_QUERY_KEY });
      return outcome;
    } finally {
      busy.current = false;
      setRetrying(false);
    }
  }, [fallback, onRetried]);

  return { retrying, message, retry };
}

