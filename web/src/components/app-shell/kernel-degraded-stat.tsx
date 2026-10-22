import { useState } from "react";
import { AlertTriangle, Copy } from "lucide-react";
import { isKernelDegraded, kernelErrorPreview, type KernelStatusView } from "@/lib/kernel-status";
import s from "./app-status-bar.module.css";

/**
 * 底栏的内核降级提示：内核没起来、桌面端已降级到配置地址时出现。
 * 一行预览 + 点开看完整 lastError 并可复制。
 */
export function KernelDegradedStat({ status }: { status: KernelStatusView | null | undefined }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const error = (status?.lastError ?? "").replace(/\s+/g, " ").trim();
  const preview = kernelErrorPreview(error) || "内核未启动，已降级到手动连接";

  if (!isKernelDegraded(status)) return null;

  const copy = async () => {
    if (!error) return;
    try {
      await navigator.clipboard.writeText(error);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span className={s.kernelDegraded} data-open={open ? "true" : undefined}>
      <button
        type="button"
        className={s.kernelDegradedButton}
        onClick={() => setOpen((value) => !value)}
        title={error || preview}
        aria-expanded={open}
        aria-label={`内核异常：${preview}`}
        data-testid="kernel-degraded-stat"
      >
        <AlertTriangle size={11} aria-hidden="true" />
        <span className={s.lbl}>内核异常</span>
        <span className={s.kernelDegradedPreview}>{preview}</span>
      </button>
      {open && (
        <span className={s.kernelDegradedDetail} role="group" aria-label="内核错误详情">
          <span className={s.kernelDegradedText}>{error || "内核未启动，已降级到手动连接"}</span>
          <button
            type="button"
            className={s.kernelDegradedCopy}
            onClick={() => void copy()}
            disabled={!error}
            data-testid="kernel-degraded-copy"
          >
            <Copy size={11} aria-hidden="true" />
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
        </span>
      )}
    </span>
  );
}
