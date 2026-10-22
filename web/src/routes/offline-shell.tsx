import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AlertTriangle, CircleOff, Compass, Globe2, Palette, RotateCcw } from "lucide-react";
import { Button } from "@hermes/shared-ui";
import { HermesLogoMark } from "@/components/brand/hermes-logo-mark";
import { useKernelRetry } from "@/hooks/use-kernel-status";
import { connectionTargetLabel, kernelErrorPreview } from "@/lib/kernel-status";
import { runtime } from "@/lib/runtime";
import { ThemeSection } from "./settings";
import { ConnectionSection } from "./settings-connection-section";
import s from "./offline-shell.module.css";

function OfflinePage({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className={s.page}>
      <header><p>Hermes 桌面版 · 离线模式</p><h1>{title}</h1><span>{sub}</span></header>
      <div className={s.body}>{children}</div>
    </section>
  );
}

function RetryButton({
  label = "重试连接",
  onRetry,
  loading = false,
}: {
  label?: string;
  onRetry?: () => void;
  loading?: boolean;
}) {
  return (
    <Button
      variant="solid"
      tone="accent"
      onClick={onRetry ?? (() => { window.location.reload(); })}
      loading={loading}
      disabled={loading}
      data-testid="offline-retry"
    >
      <RotateCcw size={12} />
      {label}
    </Button>
  );
}

function OfflineHome() {
  const runtimeConfig = window.__HERMES_RUNTIME__;
  const recoveryReason = runtimeConfig?.backendRecoveryReason;
  const remote = runtime.isRemote();
  const label = connectionTargetLabel(remote);
  const target = runtimeConfig?.dashboardApiBaseUrl
    ?? runtimeConfig?.apiBaseUrl
    ?? label;
  const kernelRetry = useKernelRetry({
    fallback: () => { window.location.reload(); },
  });

  if (recoveryReason === "external-backend-auth-required") {
    return (
      <OfflinePage
        title={remote ? "远程 Hermes 需要重新认证" : "本机内核需要重新认证"}
        sub={`${target} 已响应，但当前认证未通过。`}
      >
        <div className={s.empty}>
          <Globe2 size={32} />
          <h2>连接地址有效，凭证需要修复</h2>
          <p>请重新登录或更新访问令牌。认证完成后，桌面端会重新校验后端版本再进入工作台。</p>
          <div>
            <Button variant="solid" tone="accent" onClick={() => { window.location.hash = "#/connection"; }}>
              <Globe2 size={12} />修复认证
            </Button>
            <RetryButton />
          </div>
        </div>
      </OfflinePage>
    );
  }

  const kernelRecovered = kernelRetry.message?.tone === "ok";

  if (runtimeConfig?.backendDegraded || kernelRecovered) {
    const degradedReason = (runtimeConfig?.backendDegradedReason ?? "").trim();
    return (
      <OfflinePage
        title={kernelRecovered ? "内核已启动" : "本机内核启动失败"}
        sub={
          kernelRecovered
            ? "桌面端已重新拉起本机内核，正在重新进入工作台。"
            : `桌面端已降级到配置地址 ${target}；这不是完全离线，修好后会自动恢复。`
        }
      >
        <div className={s.empty}>
          <AlertTriangle size={32} />
          <h2>{kernelRecovered ? "内核已启动" : "内核未启动，已降级到手动连接"}</h2>
          <p>
            {kernelRecovered
              ? "内核已经在运行，会话、模型、Skills 等页面马上可用。"
              : `桌面端没拉起本机 hermes serve，退回 ${target} 继续启动界面。会话、模型、Skills 等页面在修复前不可用；
            点「重新连接内核」重试即可。`}
          </p>
          {!kernelRecovered && degradedReason && (
            <p className={s.reason} title={degradedReason}>
              {kernelErrorPreview(degradedReason)}
            </p>
          )}
          <div>
            <Button variant="solid" tone="accent" onClick={() => { window.location.hash = "#/connection"; }}>
              <Globe2 size={12} />去设置连接
            </Button>
            <RetryButton
              onRetry={() => {
                void kernelRetry.retry().then((outcome) => {
                  if (outcome?.ok) window.setTimeout(() => { window.location.reload(); }, 1_200);
                });
              }}
              loading={kernelRetry.retrying}
            />
          </div>
          {kernelRetry.message && (
            <p
              className={s.reason}
              data-tone={kernelRetry.message.tone}
              data-testid="offline-kernel-retry-message"
            >
              {kernelRetry.message.text}
            </p>
          )}
        </div>
      </OfflinePage>
    );
  }

  if (recoveryReason === "external-backend-unreachable") {
    return (
      <OfflinePage
        title={remote ? "远程 Hermes 暂时无法连接" : "本机内核暂时无法响应"}
        sub={remote ? `当前无法访问 ${target}。` : `本机内核没有响应：${target}。`}
      >
        <div className={s.empty}>
          <CircleOff size={32} />
          <h2>{remote ? "目标地址没有响应" : "本机内核没有响应"}</h2>
          <p>
            {remote
              ? "请检查后端进程、网络和保存的地址。修复后在连接页重新测试并应用。"
              : "桌面端会自己拉起本机内核并重试；也可以到连接页点「重启内核」，或先重试一次连接。"}
          </p>
          <div>
            <Button variant="solid" tone="accent" onClick={() => { window.location.hash = "#/connection"; }}>
              <Globe2 size={12} />检查连接
            </Button>
            <RetryButton />
          </div>
        </div>
      </OfflinePage>
    );
  }

  return (
    <OfflinePage
      title={remote ? "远程 Hermes 未连接" : "内核未就绪"}
      sub={
        remote
          ? "远程 Hermes 还没有连上：请检查地址、令牌或登录状态。"
          : "本机内核还在启动中：桌面端正在拉起 hermes serve，就绪后会自动进入工作台。"
      }
    >
      <div className={s.empty}>
        <CircleOff size={32} />
        <h2>工作台暂时离线</h2>
        <p>会话、模型、Skills、MCP 等页面需要内核。内核就绪后重新加载即可恢复。</p>
        <div>
          <Button variant="solid" tone="accent" onClick={() => { window.location.hash = "#/connection"; }}>
            <Globe2 size={12} />去设置连接
          </Button>
          <RetryButton />
        </div>
      </div>
    </OfflinePage>
  );
}

function OfflineAbout() {
  return (
    <OfflinePage title="关于与帮助" sub="离线时也可以访问社区和使用文档。">
      <div className={s.cards}>
        <article><Compass size={20} /><h2>重新填写连接地址</h2><p>本机内核默认由桌面端托管；也可以改成连接远程 Hermes。</p><Button variant="outline" onClick={() => { window.location.hash = "#/connection"; }}>打开连接设置</Button></article>
      </div>
    </OfflinePage>
  );
}

export function OfflineShell() {
  const { pathname } = useLocation();
  return (
    <div className={s.shell}>
      <aside>
        <div className={s.brand}><HermesLogoMark className={s.brandMark} size={32} /><div><strong>Hermes Agent</strong><small>离线控制台</small></div></div>
        <nav>
          <Link data-active={pathname === "/" ? "true" : undefined} to="/"><CircleOff size={16} />离线状态</Link>
          <Link data-active={pathname === "/connection" ? "true" : undefined} to="/connection"><Globe2 size={16} />连接</Link>
          <Link data-active={pathname === "/theme" ? "true" : undefined} to="/theme"><Palette size={16} />主题</Link>
          <Link data-active={pathname === "/about" ? "true" : undefined} to="/about"><Compass size={16} />关于</Link>
        </nav>
      </aside>
      <main>
        <Routes>
          <Route path="/" element={<OfflineHome />} />
          <Route path="/connection" element={<OfflinePage title="连接" sub="本机内核由桌面端托管，也可以连接远程 Hermes。"><ConnectionSection showHeading={false} /></OfflinePage>} />
          <Route path="/theme" element={<OfflinePage title="主题" sub="调整桌面界面的外观。"><ThemeSection showHeading={false} /></OfflinePage>} />
          <Route path="/about" element={<OfflineAbout />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
