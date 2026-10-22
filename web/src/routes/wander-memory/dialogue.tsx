// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/dialogue.tsx — #/wander-memory/dialogue: transcript
// import (§6.3). Ported from WanderMemory `web/app/src/views/DialogueView.tsx`.
// Longest latency path in the app (1 + N LLM calls): no client timeout, explicit
// copy, button disabled while the health probe reports no local LLM backend.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Button, EmptyState, LoadingState, Textarea } from "@hermes/shared-ui";
import { ErrorCard } from "@/components/wander-memory/error-card";
import { MemoryCard } from "@/components/wander-memory/memory-card";
import {
  WanderMemoryLayout,
  WanderMemorySection,
} from "@/components/wander-memory/layout";
import {
  WanderMemoryToastProvider,
  useWanderMemoryToast,
} from "@/components/wander-memory/toast";
import {
  useWanderMemoryDialogue,
  useWanderMemoryHealth,
} from "@/hooks/use-wander-memory";
import {
  COLLISION_ERROR_CODES,
  toApiError,
} from "@/lib/wander-memory";
import type { ApiError, AddDialogueResponse } from "@/lib/wander-memory";
import s from "./dialogue.module.css";

/** True when the health probe reports no reachable local LLM backend. */
function useWanderMemoryDegraded(): boolean {
  const health = useWanderMemoryHealth({ refetchInterval: 30_000 });
  return (
    health.isError ||
    (health.data !== undefined &&
      Object.keys(health.data.backends).length === 0 &&
      health.data.backend === undefined)
  );
}

function DialoguePage() {
  const toast = useWanderMemoryToast();
  const dialogue = useWanderMemoryDialogue();
  const degraded = useWanderMemoryDegraded();

  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AddDialogueResponse | null>(null);
  const [failError, setFailError] = useState<ApiError | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const looksLikeJson = (() => {
    const t = text.trim();
    if (!t.startsWith("[")) return false;
    try {
      const v = JSON.parse(t) as unknown;
      return (
        Array.isArray(v) &&
        v.every((m) => m && typeof m === "object" && "role" in m && "content" in m)
      );
    } catch {
      return false;
    }
  })();

  const submit = async () => {
    setInlineError(null);
    setFailError(null);
    setResult(null);
    if (!text.trim()) {
      setInlineError("字段 'dialogue' 不能为空字符串");
      return;
    }
    setRunning(true);
    try {
      // Sent verbatim (may be a transcript string or a JSON message array).
      const res = await dialogue.mutateAsync({ dialogue: text });
      setResult(res);
      toast.push("success", `已导入 ${res.stored.length} 条记忆 — 记忆库共 ${res.total} 条`);
    } catch (err) {
      const apiErr = toApiError(err);
      if ((COLLISION_ERROR_CODES as readonly string[]).includes(apiErr.code)) {
        setFailError(apiErr);
      } else if (apiErr.code === "bad_request") {
        setInlineError(apiErr.message);
      } else {
        toast.push("error", `${apiErr.code}: ${apiErr.message}`);
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={s.dialogueGrid}>
      {/* ── left: dialogue import ── */}
      <WanderMemorySection
        title="对话导入"
        hint="抽取 + N 次冲突判定 LLM 调用 · 全应用最慢的路径 · 客户端不设超时"
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          placeholder={
            "粘贴对话记录（一行一句）…\n\nuser: 我对花生过敏\nassistant: 已记下\n\n…或粘贴 {\"role\",\"content\"} 消息数组的 JSON — 会原样发送。"
          }
          mono
          className={s.dialogueTextarea}
        />
        {looksLikeJson ? (
          <p className={s.jsonHint}>✓ 已识别为 JSON 消息数组 — 将原样发送</p>
        ) : null}
        {inlineError ? <p className={s.inlineError}>{inlineError}</p> : null}

        <div className={s.importActions}>
          <Button
            type="button"
            variant="outline"
            tone="accent"
            onClick={() => void submit()}
            loading={running}
            disabled={running || degraded}
          >
            {running ? "抽取与冲突判定中…" : "导入对话"}
          </Button>
          {degraded ? <span className={s.degradedHint}>已禁用 — LLM 不可用</span> : null}
        </div>

        {running ? (
          <div className={s.runningBox}>
            <LoadingState
              label="正在运行抽取与冲突判定流程 — 可能要等一会儿（1 + N 次 LLM 调用）"
              variant="block"
            />
          </div>
        ) : null}
        {failError ? (
          <div className={s.runningBox}>
            <ErrorCard error={failError} onDismiss={() => setFailError(null)} />
          </div>
        ) : null}

        <p className={s.footnote}>
          失败即封闭：出现任何 collision_* 错误时，这段对话的内容一条都不会被存储。
        </p>
      </WanderMemorySection>

      {/* ── right: results ── */}
      <WanderMemorySection title="导入结果">
        {result ? (
          <>
            <h3 className={s.resultSummary}>
              已存储 <span className={s.resultNum}>{result.stored.length}</span> 条 · 共{" "}
              <span className={s.resultNum}>{result.total}</span> 条
            </h3>
            <div className={s.resultsList}>
              {result.stored.map((item, i) => (
                <MemoryCard key={item.id} item={item} collision={result.collisions[i]} />
              ))}
            </div>
          </>
        ) : !running ? (
          <EmptyState
            title="导入结果会显示在这里"
            description="每条已存记忆及其按顺序对齐的冲突摘要"
          />
        ) : null}
      </WanderMemorySection>
    </div>
  );
}

export function WanderMemoryDialogueRoute() {
  return (
    <WanderMemoryLayout title="对话导入" sub="MemOS · 对话导入">
      <WanderMemoryToastProvider>
        <DialoguePage />
      </WanderMemoryToastProvider>
    </WanderMemoryLayout>
  );
}
