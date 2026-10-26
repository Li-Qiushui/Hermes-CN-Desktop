export type KernelSystemMessageKind =
  | "interrupted-waiting-model"
  | "interrupted-api-error"
  | "interrupted-retrying-api-call"
  | "interrupted-empty-response"
  | "interrupted-provider-recovery"
  | "interrupted-during-retry"
  | "request-not-processed"
  | "partial-turn-not-complete";

export interface KernelSystemMessage {
  kind: KernelSystemMessageKind;
  text: string;
  interrupted: boolean;
}

interface SystemMessageRule {
  kind: KernelSystemMessageKind;
  pattern: RegExp;
  render: (match: RegExpMatchArray) => string;
}

const RULES: SystemMessageRule[] = [
  {
    kind: "interrupted-waiting-model",
    pattern: /^Operation interrupted:\s*waiting for model response \((\d+(?:\.\d+)?)s elapsed\)\.?$/i,
    render: (match) => `已中断（等待模型响应 ${match[1]} 秒）。`,
  },
  {
    kind: "interrupted-api-error",
    pattern: /^Operation interrupted:\s*handling API error \(([\s\S]+)\)\.?$/i,
    render: (match) => `已中断（处理 API 错误：${match[1]!.trim()}）。`,
  },
  {
    kind: "interrupted-retrying-api-call",
    pattern: /^Operation interrupted:\s*retrying API call after error \(retry (\d+)\/(\d+)\)\.?$/i,
    render: (match) => `已中断（API 调用出错后重试第 ${match[1]}/${match[2]} 次）。`,
  },
  {
    kind: "interrupted-empty-response",
    pattern: /^Operation interrupted:\s*retrying empty response from model \(retry (\d+)\/(\d+)\)\.?$/i,
    render: (match) => `已中断（模型返回空响应，重试第 ${match[1]}/${match[2]} 次）。`,
  },
  {
    kind: "interrupted-provider-recovery",
    pattern: /^Operation interrupted:\s*waiting for the provider to recover \(cycle (\d+)\/(\d+)\)\.?$/i,
    render: (match) => `已中断（等待服务商恢复，第 ${match[1]}/${match[2]} 轮）。`,
  },
  {
    kind: "interrupted-during-retry",
    pattern: /^Operation interrupted during retry \(([\s\S]+),\s*attempt (\d+)\/(\d+)\)\.?$/i,
    render: (match) => `已中断（重试中断：${match[1]!.trim()}，第 ${match[2]}/${match[3]} 次）。`,
  },
  {
    kind: "request-not-processed",
    pattern: /^Your request was not processed\.\s*Send it again if you still want me to carry it out\.$/i,
    render: () => "本次请求未被执行，如果还需要，请重新发送。",
  },
  {
    kind: "partial-turn-not-complete",
    pattern:
      /^This turn did not complete\.\s*Some actions may already have run;\s*verify their effects before resending\.$/i,
    render: () => "本回合没有完成，部分操作可能已经执行，请先核对结果再重新发送。",
  },
];

const TAIL_MARKERS = [
  "Operation interrupted during retry",
  "Operation interrupted:",
  "Your request was not processed.",
  "This turn did not complete.",
] as const;

export function translateKernelSystemMessage(raw: string): KernelSystemMessage | null {
  const text = raw.trim();
  if (!text) return null;
  for (const rule of RULES) {
    const match = text.match(rule.pattern);
    if (match) return { kind: rule.kind, text: rule.render(match), interrupted: true };
  }
  return null;
}

export function isKernelSystemMessageText(raw: string | undefined | null): boolean {
  if (!raw) return false;
  return translateKernelSystemMessage(raw) !== null;
}

export interface KernelSystemTail {
  head: string;
  tail: KernelSystemMessage;
}

export function splitKernelSystemTail(raw: string): KernelSystemTail | null {
  if (!raw) return null;
  for (const marker of TAIL_MARKERS) {
    let index = raw.lastIndexOf(marker);
    while (index > 0) {
      const tail = translateKernelSystemMessage(raw.slice(index));
      if (tail) return { head: raw.slice(0, index).trimEnd(), tail };
      index = raw.lastIndexOf(marker, index - 1);
    }
  }
  return null;
}
