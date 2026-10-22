import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { runtime } from "@/lib/runtime";
import {
  KERNEL_RETRY_QUERY_KEY,
  describeKernelRetry,
  retryKernel,
  type KernelRetryOutcome,
  type KernelStatusView,
} from "@/lib/kernel-status";

function syncDegradedFlag(status: KernelStatusView): void {
  const config = typeof window === "undefined" ? undefined : window.__HERMES_RUNTIME__;
  if (!config) return;
  if (status.mode !== "attached" && status.mode !== "spawned" && status.mode !== "remote") return;
  config.backendDegraded = false;
  config.backendDegradedReason = undefined;
}

export function useKernelStatus() {
  return useQuery<KernelStatusView>({
    queryKey: ["kernel-status"],
    queryFn: async () => {
      const next = await window.hermesDesktop!.kernelStatus!();
      syncDegradedFlag(next);
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
          syncDegradedFlag(next);
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
      const next = await retryKernel();
      if (!next) {
        if (fallback) await fallback();
        return null;
      }
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

