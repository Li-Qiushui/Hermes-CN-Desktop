// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/memories.tsx — #/wander-memory/memories: inventory +
// search + add + delete (§6.2). Ported from WanderMemory
// `web/app/src/views/MemoriesView.tsx` onto Hermes hooks + shared-ui.
//
// The request-epoch staleness guard (§6.2) is ported verbatim: every read
// captures the current epoch; a write (add/delete) bumps it once it succeeds,
// so a list/search snapshot taken BEFORE the write can never land AFTER it and
// resurrect deleted memories (or clobber a just-added one) in the UI. Writes go
// through the TanStack mutation hooks (useWanderMemoryAdd / useWanderMemoryDelete)
// which additionally invalidate the list/search query cache server-side.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ServerOff } from "lucide-react";
import { Button, Dialog, EmptyState, Input, LoadingState, Textarea } from "@hermes/shared-ui";
import { CollisionLine } from "@/components/wander-memory/collision-line";
import { ErrorCard } from "@/components/wander-memory/error-card";
import { MemoryCard } from "@/components/wander-memory/memory-card";
import {
  PageGrid,
  WanderMemoryLayout,
  WanderMemorySection,
} from "@/components/wander-memory/layout";
import {
  WanderMemoryToastProvider,
  useWanderMemoryToast,
} from "@/components/wander-memory/toast";
import { useWanderMemoryAdd, useWanderMemoryDelete, useWanderMemoryHealth } from "@/hooks/use-wander-memory";
import {
  ApiError,
  COLLISION_ERROR_CODES,
  getWanderMemoryClient,
  isWanderMemoryOffline,
  toApiError,
  wanderMemoryListPhase,
} from "@/lib/wander-memory";
import type { CollisionSummary, MemoryItem } from "@/lib/wander-memory";
import s from "./memories.module.css";

/** CLI-style metadata editor convention: key=value lines (§6.2). */
function parseMetadata(text: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return null;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function MemoriesPage() {
  const toast = useWanderMemoryToast();
  const navigate = useNavigate();
  const add = useWanderMemoryAdd();
  const del = useWanderMemoryDelete();
  const health = useWanderMemoryHealth();

  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState("");
  const [results, setResults] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [offline, setOffline] = useState(false);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const [newText, setNewText] = useState("");
  const [newMeta, setNewMeta] = useState("");
  const [addCollision, setAddCollision] = useState<CollisionSummary | null>(null);
  const [addError, setAddError] = useState<ApiError | null>(null);

  const [viewId, setViewId] = useState<string | null>(null);
  const [viewData, setViewData] = useState<unknown>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Staleness guard for async list/search responses. Every read captures the
  // current epoch; a write (add/delete) bumps it once it succeeds, so a
  // list/search snapshot taken BEFORE the write can never land AFTER it and
  // resurrect deleted memories (or clobber a just-added one) in the UI.
  const reqSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await getWanderMemoryClient().list();
      if (seq !== reqSeq.current) return; // superseded by a newer request/write
      setResults(res.results);
      setListError(null);
      setOffline(false);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      const apiErr = toApiError(err);
      if (isWanderMemoryOffline(apiErr)) {
        setOffline(true);
        setListError(null);
      } else {
        setOffline(false);
        setListError(apiErr);
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doSearch = async () => {
    const q = query.trim();
    if (!q) {
      setSearching(true);
      await refresh();
      setSearching(false);
      return;
    }
    setSearching(true);
    setListError(null);
    setInlineError(null);
    const seq = ++reqSeq.current;
    try {
      const k = topK.trim() ? Number(topK) : undefined;
      const res = await getWanderMemoryClient().search(q, k);
      if (seq !== reqSeq.current) return; // superseded by a newer request/write
      setResults(res.results);
      setOffline(false);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      const apiErr = toApiError(err);
      if (isWanderMemoryOffline(apiErr)) {
        setOffline(true);
      } else if (apiErr.code === "bad_request") setInlineError(apiErr.message);
      else toast.push("error", `${apiErr.code}: ${apiErr.message}`);
    } finally {
      if (seq === reqSeq.current) setSearching(false);
    }
  };

  const doAdd = async () => {
    setInlineError(null);
    setAddError(null);
    setAddCollision(null);
    if (!newText.trim()) {
      setInlineError("字段 'memory' 不能为空字符串");
      return;
    }
    const meta = newMeta.trim() ? parseMetadata(newMeta) : {};
    if (meta === null) {
      setInlineError("metadata 需为每行一条 key=value（例如 type=fact）");
      return;
    }
    try {
      const res = await add.mutateAsync({
        text: newText.trim(),
        metadata: Object.keys(meta).length ? meta : undefined,
      });
      setAddCollision(res.collision);
      setNewText("");
      setNewMeta("");
      // The write changed server state — invalidate any in-flight list/search
      // snapshot taken before it, then reconcile in the background (§6.2).
      reqSeq.current += 1;
      if (res.collision.stored_new) setResults((r) => [res.memory, ...r]);
      void refresh();
    } catch (err) {
      const apiErr = toApiError(err);
      if ((COLLISION_ERROR_CODES as readonly string[]).includes(apiErr.code)) {
        setAddError(apiErr);
      } else if (apiErr.code === "bad_request") {
        setInlineError(apiErr.message);
      } else {
        toast.push("error", `${apiErr.code}: ${apiErr.message}`);
      }
    }
  };

  const doView = async (id: string) => {
    try {
      const res = await getWanderMemoryClient().get(id);
      setViewData(res);
      setViewId(id);
    } catch (err) {
      const apiErr = toApiError(err);
      if (apiErr.code === "not_found") {
        toast.push("error", "找不到该记忆 — 列表可能已过期");
        void refresh();
      } else {
        toast.push("error", `${apiErr.code}: ${apiErr.message}`);
      }
    }
  };

  const doDelete = async () => {
    const id = deleteId;
    setDeleteId(null);
    if (!id) return;
    setDeletingId(id);
    try {
      await del.mutateAsync({ id });
      // The DELETE succeeded — invalidate any in-flight list/search snapshot
      // taken before it, so the deleted memory can never be resurrected in the
      // UI by a stale response landing after this point.
      reqSeq.current += 1;
      setResults((r) => r.filter((m) => m.id !== id));
      toast.push("success", `已删除 ${id.slice(0, 8)}…`);
    } catch (err) {
      const apiErr = toApiError(err);
      if (apiErr.code === "not_found") {
        toast.push("error", "找不到该记忆 — 列表可能已过期");
        void refresh();
      } else {
        toast.push("error", `${apiErr.code}: ${apiErr.message}`);
        // The server may still have applied the DELETE (e.g. a timed-out
        // response) — re-sync instead of trusting the stale local list.
        void refresh();
      }
    } finally {
      setDeletingId(null);
    }
  };

  const busy = loading || searching;
  const isOffline = offline || isWanderMemoryOffline(health.error);
  const phase = wanderMemoryListPhase({
    offline: isOffline,
    hasError: listError !== null,
    resultCount: results.length,
  });

  return (
    <PageGrid>
      {/* ── left: search + results ── */}
      <WanderMemorySection title="检索与库存" hint="空查询即列出全部记忆">
        <div className={s.searchRow}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doSearch();
            }}
            placeholder="搜索记忆…（空查询即列出全部记忆）"
            mono
            className={s.searchInput}
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
            onClick={() => void doSearch()}
            loading={searching}
          >
            {searching ? "…" : "搜索"}
          </Button>
        </div>
        {inlineError ? <p className={s.inlineError}>{inlineError}</p> : null}

        <div className={s.results}>
          {busy ? (
            <LoadingState label="正在加载记忆…" variant="block" />
          ) : phase === "offline" ? (
            <EmptyState
              icon={<ServerOff size={20} aria-hidden="true" />}
              title="记忆服务未连接"
              description="没连上 MemOS 记忆服务（默认 18400 / 18401 / 18402），所以这里没有任何数据。启动 MemOS 后点重试，或去状态页检查端点设置。"
              actions={
                <div className={s.emptyActions}>
                  <Button type="button" variant="outline" tone="accent" size="sm" onClick={() => void refresh()}>
                    重试
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/wander-memory/status")}>
                    去设置
                  </Button>
                </div>
              }
            />
          ) : phase === "failed" && listError ? (
            <ErrorCard
              error={listError}
              onDismiss={() => setListError(null)}
              retry={() => void refresh()}
            />
          ) : phase === "empty" ? (
            <EmptyState
              title="还没有匹配的记忆"
              description={
                query.trim()
                  ? "没有搜到相关内容，换个关键词重新搜索，或在右侧添加一条记忆。"
                  : "记忆库还是空的，在右侧添加第一条记忆。"
              }
            />
          ) : (
            results.map((m) => (
              <MemoryCard
                key={m.id}
                item={m}
                onView={(id) => void doView(id)}
                onDelete={setDeleteId}
                deleting={deletingId === m.id}
              />
            ))
          )}
        </div>
      </WanderMemorySection>

      {/* ── right: add memory ── */}
      <WanderMemorySection title="添加记忆" hint="0–1 次 LLM 调用 · 约数秒">
        <div className={s.addPanel}>
          <Textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={4}
            placeholder="记忆内容…"
            className={s.addTextarea}
          />
          <Textarea
            value={newMeta}
            onChange={(e) => setNewMeta(e.target.value)}
            rows={2}
            placeholder={"metadata（可选，每行一条 key=value）\ntype=fact"}
            mono
            className={s.addTextarea}
          />
          <Button
            type="button"
            variant="outline"
            tone="accent"
            fullWidth
            onClick={() => void doAdd()}
            loading={add.isPending}
            disabled={add.isPending}
            className={s.addButton}
          >
            {add.isPending ? "存储中…" : "存储记忆"}
          </Button>

          <div className={s.addFeedback}>
            {addError ? (
              <ErrorCard error={addError} onDismiss={() => setAddError(null)} />
            ) : addCollision ? (
              <div className={s.collisionBox}>
                <CollisionLine collision={addCollision} />
              </div>
            ) : null}
          </div>

          <p className={s.footnote}>
            失败即封闭：出现 collision_parse_failed / collision_validation_failed / collision_apply_failed
            时，这条记忆不会被存储。系统没有更新接口 — 写入只有「新增 + 冲突合并」一条路径。
          </p>
        </div>
      </WanderMemorySection>

      {/* ── view JSON ── */}
      <Dialog.Root
        open={viewId !== null && viewData !== null}
        onOpenChange={(open) => {
          if (!open) {
            setViewId(null);
            setViewData(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className={s.dialogContent}>
            <Dialog.Title className={s.dialogTitle}>
              GET /v1/memories/{viewId?.slice(0, 8)}…
            </Dialog.Title>
            <pre className={s.jsonBlock}>{JSON.stringify(viewData, null, 2)}</pre>
            <div className={s.dialogActions}>
              <Dialog.Close asChild>
                <Button type="button" variant="outline" size="sm">
                  关闭
                </Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── delete confirm ── */}
      <Dialog.Root
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className={s.dialogContent}>
            <Dialog.Title>删除记忆</Dialog.Title>
            <Dialog.Description className={s.dialogDesc}>
              确定删除记忆 {deleteId?.slice(0, 8)}…？此操作会调用 DELETE /v1/memories/{`{id}`}，且无法撤销。
            </Dialog.Description>
            <div className={s.dialogActions}>
              <Button type="button" variant="outline" onClick={() => setDeleteId(null)} disabled={deletingId !== null}>
                取消
              </Button>
              <Button
                type="button"
                variant="solid"
                tone="danger"
                onClick={() => void doDelete()}
                loading={deletingId !== null}
                disabled={deletingId !== null}
              >
                删除
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </PageGrid>
  );
}

export function WanderMemoryMemoriesRoute() {
  return (
    <WanderMemoryLayout title="记忆" sub="MemOS · 记忆库">
      <WanderMemoryToastProvider>
        <MemoriesPage />
      </WanderMemoryToastProvider>
    </WanderMemoryLayout>
  );
}
