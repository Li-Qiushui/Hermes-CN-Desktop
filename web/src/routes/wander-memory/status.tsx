// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/status.tsx — #/wander-memory/status: server
// introspection + maintenance + endpoint discovery (§6.6). Ported from
// WanderMemory `web/app/src/views/StatusView.tsx` onto the Hermes hooks:
//   • health / models / backends cards from useWanderMemoryHealth /
//     useWanderMemoryModels / useWanderMemoryBackends (re-probed by their
//     query intervals)
//   • endpoint display from resolveEndpoints() (env → ui-store → defaults)
//   • mode badge (live/demo) from the singleton client
//   • "重新发现端点" runs resolveEndpointsAsync() (port-shift discovery, cached
//     in ui-store), rebuilds the singleton via resetWanderMemoryClient(createMemOsClient(next))
//     and invalidates every wander-memory query so they re-run against the
//     recreated client.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, LoadingState } from "@hermes/shared-ui";
import { ErrorCard } from "@/components/wander-memory/error-card";
import {
  WanderMemoryLayout,
  WanderMemorySection,
} from "@/components/wander-memory/layout";
import {
  WanderMemoryToastProvider,
  useWanderMemoryToast,
} from "@/components/wander-memory/toast";
import {
  WANDER_MEMORY_QUERY_KEYS,
  useWanderMemoryBackends,
  useWanderMemoryHealth,
  useWanderMemoryMaintenance,
  useWanderMemoryModels,
} from "@/hooks/use-wander-memory";
import {
  createMemOsClient,
  getWanderMemoryClient,
  resetWanderMemoryClient,
  resolveEndpoints,
  resolveEndpointsAsync,
  toApiError,
  wanderErrorLine,
} from "@/lib/wander-memory";
import type { ApiError, WanderMemoryEndpoints } from "@/lib/wander-memory";
import s from "./status.module.css";

interface ServerStatusPresentationInput {
  mode: "live" | "demo";
  loading: boolean;
  hasData: boolean;
  hasError: boolean;
}

export function serverStatusPresentation({
  mode,
  loading,
  hasData,
  hasError,
}: ServerStatusPresentationInput): {
  label: "检查中" | "离线" | "在线" | "演示";
  tone: "neutral" | "danger" | "success" | "warning";
} {
  if (mode === "demo") return { label: "演示", tone: "warning" };
  if (hasError) return { label: "离线", tone: "danger" };
  if (hasData) return { label: "在线", tone: "success" };
  if (loading) return { label: "检查中", tone: "neutral" };
  return { label: "离线", tone: "danger" };
}

export function wanderStatusErrorText(error: ApiError): string {
  if (error.code === "network_failure") {
    return "离线 — 请启动 MemOS，或在下方更新端点设置";
  }
  return wanderErrorLine(error);
}

function StatusPage() {
  const qc = useQueryClient();
  const toast = useWanderMemoryToast();

  const health = useWanderMemoryHealth();
  const models = useWanderMemoryModels();
  const backends = useWanderMemoryBackends();
  const maintenance = useWanderMemoryMaintenance();

  const [mode, setMode] = useState<"live" | "demo">(() => getWanderMemoryClient().mode);
  const [eps, setEps] = useState<WanderMemoryEndpoints>(() => resolveEndpoints());
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<ApiError | null>(null);

  const rediscover = async () => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      // Port-shift discovery (env → ui-store → ports file/probe → defaults);
      // the discovered trio is cached in ui-store by the endpoints module.
      const next = await resolveEndpointsAsync();
      // Rebuild the singleton (disposes the old WS) so every hook re-runs
      // against the recreated client.
      resetWanderMemoryClient(createMemOsClient(next));
      setEps(next);
      setMode(getWanderMemoryClient().mode);
      qc.invalidateQueries({ queryKey: WANDER_MEMORY_QUERY_KEYS.all });
      toast.push("success", "端点已重新发现，客户端已重连");
    } catch (err) {
      setDiscoverError(toApiError(err));
    } finally {
      setDiscovering(false);
    }
  };

  const introspectError = health.error ?? models.error ?? backends.error;
  const introspectLoading = [health, models, backends].some(
    (query) => query.isLoading && !query.data,
  );
  const serverStatus = serverStatusPresentation({
    mode,
    loading: introspectLoading,
    hasData: Boolean(health.data),
    hasError: Boolean(introspectError),
  });

  const modeBadge = (
    <Badge tone={serverStatus.tone} variant="outline" size="sm">
      {serverStatus.label}
    </Badge>
  );

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.headRow}>
        <span className={s.title}>服务状态</span>
        {modeBadge}
        <span className={s.headHint}>健康状态每 30 秒重新探测</span>
      </div>

      {/* ── health / models / backends cards ── */}
      <div className={s.cardsGrid}>
        <section className={s.card}>
          <h3 className={s.cardTitle}>健康</h3>
          {health.isLoading && !health.data ? (
            <p className={s.cardMuted}>加载中…</p>
          ) : health.error ? (
            <p className={s.cardError}>{wanderStatusErrorText(health.error)}</p>
          ) : health.data ? (
            <dl className={s.defList}>
              <div className={s.defRow}>
                <dt className={s.defTerm}>状态</dt>
                <dd className={`${s.defValue} ${s.okValue}`}>{health.data.status}</dd>
              </div>
              <div className={s.defRow}>
                <dt className={s.defTerm}>模型</dt>
                <dd className={s.defValue}>{health.data.model}</dd>
              </div>
              {health.data.backend !== undefined ? (
                <div className={s.defRow}>
                  <dt className={s.defTerm}>后端</dt>
                  <dd className={s.defValue}>{health.data.backend}</dd>
                </div>
              ) : null}
              {Object.entries(health.data.backends).map(([name, ok]) => (
                <div key={name} className={s.defRow}>
                  <dt className={s.defTerm}>{name}</dt>
                  <dd className={ok ? s.okValue : s.errValue}>{ok ? "✓" : "✗"}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className={s.cardMuted}>不可用</p>
          )}
        </section>

        <section className={s.card}>
          <h3 className={s.cardTitle}>模型</h3>
          {models.isLoading && !models.data ? (
            <p className={s.cardMuted}>加载中…</p>
          ) : models.error ? (
            <p className={s.cardError}>{wanderStatusErrorText(models.error)}</p>
          ) : models.data ? (
            <>
              <dl className={s.defList}>
                <div className={s.defRow}>
                  <dt className={s.defTerm}>模型</dt>
                  <dd className={s.defValue}>{models.data.model}</dd>
                </div>
                <div className={s.defRow}>
                  <dt className={s.defTerm}>推理</dt>
                  <dd className={s.defValue}>{models.data.reasoning}</dd>
                </div>
              </dl>
              {models.data.reasoning !== "off" ? (
                <Alert tone="warning" size="sm" className={s.modelWarning}>
                  警告：reasoning 预期应为 "off"
                </Alert>
              ) : null}
            </>
          ) : (
            <p className={s.cardMuted}>不可用</p>
          )}
        </section>

        <section className={s.card}>
          <h3 className={s.cardTitle}>后端</h3>
          {backends.isLoading && !backends.data ? (
            <p className={s.cardMuted}>加载中…</p>
          ) : backends.error ? (
            <p className={s.cardError}>{wanderStatusErrorText(backends.error)}</p>
          ) : backends.data ? (
            backends.data.remote || backends.data.devices.length === 0 ? (
              <p className={s.cardMuted}>远程后端 — 没有 llama.cpp 设备</p>
            ) : (
              <table className={s.deviceTable}>
                <thead>
                  <tr>
                    <th className={s.th}>后端</th>
                    <th className={s.th}>序号</th>
                    <th className={s.th}>名称</th>
                    <th className={`${s.th} ${s.thRight}`}>MiB</th>
                  </tr>
                </thead>
                <tbody>
                  {backends.data.devices.map((d) => (
                    <tr key={`${d.backend}:${d.index}`}>
                      <td className={s.td}>{d.backend}</td>
                      <td className={s.td}>{d.index}</td>
                      <td className={s.td}>{d.name}</td>
                      <td className={`${s.td} ${s.tdRight}`}>{d.total_mib.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <p className={s.cardMuted}>不可用</p>
          )}
        </section>
      </div>

      {introspectError ? (
        <Alert tone="danger" size="sm">
          自检失败：{wanderStatusErrorText(introspectError)}
        </Alert>
      ) : null}

      {/* ── maintenance ── */}
      <WanderMemorySection title="维护" hint="POST /v1/maintenance — 重新校验整个记忆库">
        <div className={s.maintRow}>
          <div>
            <p className={s.maintDesc}>重新校验每一条已存记忆；返回总数与逐条错误。</p>
          </div>
          <Button
            type="button"
            variant="outline"
            tone="accent"
            onClick={() => void maintenance.mutateAsync().catch((err) => toast.push("error", toApiError(err).message))}
            loading={maintenance.isPending}
            className={s.maintButton}
          >
            {maintenance.isPending ? "运行中…" : "运行维护"}
          </Button>
        </div>
        {maintenance.isPending ? (
          <div className={s.maintRunning}>
            <LoadingState label="正在校验记忆库…" variant="block" />
          </div>
        ) : null}
        {maintenance.data ? (
          <div className={s.maintResult}>
            总数：<span className={s.maintNum}>{maintenance.data.total}</span> · 错误：{" "}
            {maintenance.data.errors.length === 0 ? (
              <span className={s.okValue}>无</span>
            ) : (
              <span className={s.errValue}>{maintenance.data.errors.join("; ")}</span>
            )}
          </div>
        ) : null}
        {maintenance.error ? (
          <p className={s.maintError}>{wanderErrorLine(maintenance.error)}</p>
        ) : null}
      </WanderMemorySection>

      {/* ── endpoint settings / discovery ── */}
      <WanderMemorySection
        title="端点设置"
        hint="环境变量 → ui-store 覆盖 → 端口漂移探测 → 默认值"
      >
        <dl className={s.defList}>
          <div className={s.defRow}>
            <dt className={s.defTerm}>API 基础地址（REST）</dt>
            <dd className={`${s.defValue} ${s.endpointValue}`}>{eps.apiOrigin}</dd>
          </div>
          <div className={s.defRow}>
            <dt className={s.defTerm}>WebSocket 地址</dt>
            <dd className={`${s.defValue} ${s.endpointValue}`}>{eps.wsUrl}</dd>
          </div>
          <div className={s.defRow}>
            <dt className={s.defTerm}>文件服务地址（mem_filesys）</dt>
            <dd className={`${s.defValue} ${s.endpointValue}`}>{eps.fsOrigin}</dd>
          </div>
        </dl>
        <div className={s.discoverRow}>
          <Button
            type="button"
            variant="outline"
            tone="accent"
            onClick={() => void rediscover()}
            loading={discovering}
          >
            {discovering ? "探测中…" : "重新发现端点"}
          </Button>
          <span className={s.discoverHint}>
            重新探测 18400–18409 端口（以及端口文件），然后重连客户端
          </span>
        </div>
        {discoverError ? (
          <div className={s.discoverError}>
            <ErrorCard error={discoverError} onDismiss={() => setDiscoverError(null)} />
          </div>
        ) : null}
      </WanderMemorySection>
      </div>
    </div>
  );
}

export function WanderMemoryStatusRoute() {
  return (
    <WanderMemoryLayout title="状态" sub="MemOS · 状态">
      <WanderMemoryToastProvider>
        <StatusPage />
      </WanderMemoryToastProvider>
    </WanderMemoryLayout>
  );
}
