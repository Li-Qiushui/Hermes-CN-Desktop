// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineShell } from "./offline-shell";

function installWindow(desktop: Record<string, unknown>) {
  window.__HERMES_RUNTIME__ = {
    platform: "tauri",
    connectionMode: "local",
    backendReady: false,
    backendDegraded: true,
    backendDegradedReason: "spawn hermes serve 失败：找不到可执行文件",
    backendRecoveryReason: "external-backend-unreachable",
    dashboardApiBaseUrl: "http://127.0.0.1:9119",
  };
  window.hermesDesktop = { windowType: "tauri", ...desktop } as never;
}

function renderShell() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <OfflineShell />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.__HERMES_RUNTIME__ = undefined;
  window.hermesDesktop = undefined;
});

describe("离线壳的降级重试", () => {
  it("调 retry_kernel 成功后提示「内核已启动」", async () => {
    installWindow({ retryKernel: vi.fn().mockResolvedValue({ mode: "spawned", port: 51274, lastError: null }) });
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as never);

    renderShell();
    fireEvent.click(screen.getByTestId("offline-retry"));

    const message = await screen.findByTestId("offline-kernel-retry-message");
    expect(message.textContent).toBe("内核已启动");
    expect(window.__HERMES_RUNTIME__?.backendDegraded).toBe(false);
    expect(window.hermesDesktop?.retryKernel).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("仍降级时展示新的 lastError", async () => {
    installWindow({
      retryKernel: vi.fn().mockResolvedValue({
        mode: "degraded",
        baseUrl: "http://127.0.0.1:9119",
        lastError: "端口 9119 仍被占用",
      }),
    });

    renderShell();
    fireEvent.click(screen.getByTestId("offline-retry"));

    const message = await screen.findByTestId("offline-kernel-retry-message");
    expect(message.textContent).toContain("端口 9119 仍被占用");
    expect(window.__HERMES_RUNTIME__?.backendDegraded).toBe(true);
  });

  it("非桌面环境下退回页面重载", async () => {
    installWindow({});
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as never);

    renderShell();
    fireEvent.click(screen.getByTestId("offline-retry"));

    await waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("offline-kernel-retry-message")).toBeNull();
  });
});
