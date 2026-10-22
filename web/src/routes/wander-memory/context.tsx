// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/context.tsx — #/wander-memory/context: prompt-injection
// block preview (§6.5). Ported from WanderMemory
// `web/app/src/views/ContextView.tsx` onto useWanderMemoryContext.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Button, CopyButton, EmptyState, Input, LoadingState } from "@hermes/shared-ui";
import { ErrorCard } from "@/components/wander-memory/error-card";
import {
  WanderMemoryLayout,
  WanderMemorySection,
} from "@/components/wander-memory/layout";
import { useWanderMemoryContext } from "@/hooks/use-wander-memory";
import { toApiError } from "@/lib/wander-memory";
import type { ApiError } from "@/lib/wander-memory";
import s from "./context.module.css";

function ContextPage() {
  const build = useWanderMemoryContext();
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState("");
  const [context, setContext] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<ApiError | null>(null);

  const run = async () => {
    const q = query.trim();
    if (!q) return;
    setBuildError(null);
    try {
      const k = topK.trim() ? Number(topK) : undefined;
      const res = await build.mutateAsync({ query: q, topK: k });
      setContext(res.context);
    } catch (err) {
      setBuildError(toApiError(err));
    }
  };

  return (
    <WanderMemorySection
      title="上下文预览"
      hint="POST /v1/context — 与注入提示词中的日期前缀块完全一致"
    >
      <div className={s.buildRow}>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
          placeholder="查询内容…"
          mono
          className={s.queryInput}
        />
        <Input
          value={topK}
          onChange={(e) => setTopK(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="top_k"
          title="top_k — 留空则使用服务端默认值"
          mono
          className={s.topK}
        />
        <Button
          type="button"
          variant="outline"
          tone="accent"
          onClick={() => void run()}
          loading={build.isPending}
          disabled={!query.trim()}
        >
          生成
        </Button>
      </div>

      <div className={s.output}>
        {buildError ? (
          <ErrorCard
            error={buildError}
            onDismiss={() => setBuildError(null)}
            retry={() => void run()}
          />
        ) : build.isPending ? (
          <LoadingState label="正在生成上下文…" variant="block" />
        ) : context === null ? null : context === "" ? (
          <EmptyState title="没有匹配的记忆 — 接口返回了空字符串" />
        ) : (
          <div className={s.contextBlock}>
            <div className={s.contextHead}>
              <span className={s.contextLabel}>上下文</span>
              <CopyButton text={context} variant="outline" size="xs" copiedLabel="已复制">
                复制
              </CopyButton>
            </div>
            <pre className={s.contextText}>{context}</pre>
          </div>
        )}
      </div>
    </WanderMemorySection>
  );
}

export function WanderMemoryContextRoute() {
  return (
    <WanderMemoryLayout title="上下文预览" sub="MemOS · 上下文">
      <ContextPage />
    </WanderMemoryLayout>
  );
}
