import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { OfflineShell } from "./offline-shell";

function renderRecovery(reason: "external-backend-unreachable" | "external-backend-auth-required") {
  vi.stubGlobal("window", {
    __HERMES_RUNTIME__: {
      platform: "tauri",
      connectionMode: "remote",
      backendReady: false,
      backendRecoveryReason: reason,
      dashboardApiBaseUrl: "https://remote.example.com",
    },
    location: { hash: "#/" },
  });

  return ReactDOMServer.renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <OfflineShell />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("explains how to repair an unreachable external backend", () => {
  const html = renderRecovery("external-backend-unreachable");

  expect(html).toContain("远程 Hermes 暂时无法连接");
  expect(html).toContain("https://remote.example.com");
  expect(html).toContain("检查连接");
});

it("explains how to repair external backend authentication", () => {
  const html = renderRecovery("external-backend-auth-required");

  expect(html).toContain("远程 Hermes 需要重新认证");
  expect(html).toContain("凭证需要修复");
  expect(html).toContain("修复认证");
});

it("treats a degraded kernel as repairable instead of fully offline", () => {
  vi.stubGlobal("window", {
    __HERMES_RUNTIME__: {
      platform: "tauri",
      connectionMode: "managed",
      backendReady: false,
      backendDegraded: true,
      backendDegradedReason: "spawn hermes serve 失败：找不到可执行文件",
      backendRecoveryReason: "external-backend-unreachable",
      dashboardApiBaseUrl: "http://127.0.0.1:9119",
    },
    location: { hash: "#/" },
  });

  const html = ReactDOMServer.renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <OfflineShell />
    </MemoryRouter>,
  );

  expect(html).toContain("本机内核启动失败");
  expect(html).toContain("内核未启动，已降级到手动连接");
  expect(html).toContain("http://127.0.0.1:9119");
  expect(html).toContain("spawn hermes serve 失败");
  expect(html).toContain("重试连接");
  expect(html).not.toContain("工作台暂时离线");
});
