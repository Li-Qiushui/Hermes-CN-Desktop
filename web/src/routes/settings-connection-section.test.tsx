import ReactDOMServer from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";


import { ConnectionSection } from "./settings-connection-section";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("starts in the active remote mode without transiently mounting managed controls", () => {
  vi.stubGlobal("window", {
    __HERMES_RUNTIME__: {
      platform: "tauri",
      connectionMode: "remote",
      backendReady: false,
      backendRecoveryReason: "external-backend-auth-required",
      dashboardApiBaseUrl: "https://remote.example.com",
    },
    hermesDesktop: {
      windowType: "tauri",
      getConnectionConfig: vi.fn(),
    },
  });

  const html = ReactDOMServer.renderToStaticMarkup(<ConnectionSection showHeading={false} />);

  expect(html).toContain("远程地址");
  expect(html).toContain("会话令牌");
  expect(html).not.toContain("MANAGED_PANEL_MOUNTED");
});

it("does not claim a live connection in browser-companion mode", () => {
  vi.stubGlobal("window", {
    __HERMES_RUNTIME__: {
      platform: "web",
      browserCompanion: true,
    },
  });

  const html = ReactDOMServer.renderToStaticMarkup(<ConnectionSection showHeading={false} />);

  expect(html).toContain("已配置（未探活）");
  expect(html).toContain('data-ok="false"');
  expect(html).not.toContain(">已连接<");
});
