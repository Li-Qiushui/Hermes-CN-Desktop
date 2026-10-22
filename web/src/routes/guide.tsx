import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "@hermes/shared-ui";
import { HermesLogoMark } from "@/components/brand/hermes-logo-mark";
import { runtime } from "@/lib/runtime";
import { ConnectionSection } from "./settings-connection-section";
import s from "./guide.module.css";

export function GuideRoute() {
  const navigate = useNavigate();
  const { config: themeConfig } = useTheme();
  const desktop = typeof window === "undefined" ? undefined : window.hermesDesktop;
  const setupRef = useRef<HTMLElement>(null);

  const openDesktopRoute = (path: string) => {
    if (runtime.platform === "web") {
      navigate(path, { replace: true });
      return;
    }
    window.location.hash = `#${path}`;
    window.location.reload();
  };

  const completeGuide = async () => {
    if (!desktop?.setGuideState) {
      if (runtime.platform !== "web") {
        throw new Error("当前桌面版本无法保存引导状态，请更新后重试。");
      }
      return;
    }
    const result = await desktop.setGuideState("completed");
    if (!result.ok) throw new Error(result.error ?? "无法保存引导状态");
    runtime.applyRuntimeControlResult(result);
  };

  const finishConnection = async () => {
    await completeGuide();
    openDesktopRoute("/");
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setupRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <main className={s.page} data-testid="guide-scroll-container">
      <header className={s.header}>
        <HermesLogoMark
          className={s.brandMark}
          size={44}
          title="Hermes Agent 品牌 Logo"
          tone={
            themeConfig.theme === "light" || themeConfig.theme === "light-modern"
              ? "dark"
              : "light"
          }
        />
        <div>
          <p>Hermes Agent</p>
          <h1>连接 Hermes 内核</h1>
          <span>本机内核由桌面端托管；需要时也可以连到另一台机器上的远程 Hermes。</span>
        </div>
      </header>

      <div className={s.body}>
        <section className={s.intro} aria-labelledby="guide-choice-title">
          <div className={s.introCopy}>
            <span className={s.stepLabel}>只需确认一次，以后可以随时更改</span>
            <h2 id="guide-choice-title">内核跑在哪里</h2>
            <p>默认用本机内核：桌面端启动时会自己接管或拉起内核（hermes serve），不用填地址。</p>
            <p>只有要用另一台机器上的 Hermes 时，才在「远程连接」里填地址加 Token 或 OAuth 登录。</p>
          </div>
        </section>

        <section
          ref={setupRef}
          className={s.externalSetup}
          aria-labelledby="external-setup-title"
        >
          <div className={s.externalHeader}>
            <div>
              <span className={s.stepLabel}>确认本机内核与远程连接</span>
              <h2 id="external-setup-title">确认连接目标</h2>
              <p>本机内核一般开箱可用；远程连接会让你填地址与凭证。</p>
            </div>
          </div>
          <ConnectionSection
            showHeading={false}
            externalOnly
            onApplied={finishConnection}
          />
        </section>
      </div>
    </main>
  );
}
