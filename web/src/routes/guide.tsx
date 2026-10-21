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
          <h1>连接你的外部 Hermes</h1>
          <span>桌面端是客户端：Hermes 后端运行在本机或远端服务器上。</span>
        </div>
      </header>

      <div className={s.body}>
        <section className={s.intro} aria-labelledby="guide-choice-title">
          <div className={s.introCopy}>
            <span className={s.stepLabel}>只需连接一次，以后可以随时更改</span>
            <h2 id="guide-choice-title">选择后端在哪里运行</h2>
            <p>填上已经运行的 Hermes 地址即可，默认是 http://127.0.0.1:9119。</p>
            <p>本机其他 Hermes 接入本机已经运行的 Hermes Dashboard；远端服务器 Hermes 需要地址加 Token 或 OAuth 登录。</p>
          </div>
        </section>

        <section
          ref={setupRef}
          className={s.externalSetup}
          aria-labelledby="external-setup-title"
        >
          <div className={s.externalHeader}>
            <div>
              <span className={s.stepLabel}>填写已有 Hermes 的连接信息</span>
              <h2 id="external-setup-title">连接你已有的 Hermes</h2>
              <p>选择它是在这台电脑上运行，还是在另一台电脑或服务器上运行。</p>
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
