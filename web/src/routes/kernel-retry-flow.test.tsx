// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "@/lib/query-client";
import { fetchJSON, postJSON } from "@/lib/transport";
import { ConnectionSection } from "./settings-connection-section";

vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn(),
  postJSON: vi.fn(),
}));

const degradedStatus = {
  mode: "degraded",
  baseUrl: "http://127.0.0.1:9119",
  lastError: "spawn hermes serve 失败：端口被占用",
};

const attachedStatus = {
  mode: "attached",
  baseUrl: "http://127.0.0.1:9119",
  host: "127.0.0.1",
  port: 9119,
  lastError: null,
};

const connectionView = {
  mode: "local",
  localUrl: "http://127.0.0.1:9119",
  remoteUrl: "",
  remoteTokenSet: false,
  remoteAuthMode: "token",
  remoteSessionSet: false,
  envOverride: false,
  effectiveMode: "local",
};

function installWindow(desktop: Record<string, unknown>, runtime: Record<string, unknown>) {
  window.__HERMES_RUNTIME__ = { platform: "tauri", connectionMode: "local", ...runtime };
  window.hermesDesktop = {
    windowType: "tauri",
    getConnectionConfig: vi.fn().mockResolvedValue(connectionView),
    kernelStatus: vi.fn().mockResolvedValue(degradedStatus),
    ...desktop,
  } as never;
}

async function renderDegraded() {
  render(<ConnectionSection showHeading={false} />);
  await screen.findByTestId("kernel-degraded-callout");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(fetchJSON).mockReset();
  vi.mocked(postJSON).mockReset();
  window.__HERMES_RUNTIME__ = undefined;
  window.hermesDesktop = undefined;
});

describe("设置页「重新连接内核」", () => {
  it("成功时调 retry_kernel、清降级态并重取 kernel-status", async () => {
    installWindow(
      {
        retryKernel: vi.fn().mockResolvedValue(attachedStatus),
        kernelStatus: vi
          .fn()
          .mockResolvedValueOnce(degradedStatus)
          .mockResolvedValue(attachedStatus),
      },
      { backendDegraded: true, backendDegradedReason: "旧错误" },
    );
    vi.mocked(fetchJSON).mockResolvedValue({ version: "1.0", gateway_state: "running" } as never);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

    await renderDegraded();
    fireEvent.click(screen.getByTestId("kernel-degraded-retry"));

    const result = await screen.findByTestId("kernel-retry-result");
    expect(result.textContent).toBe("内核已启动");
    expect(window.hermesDesktop?.retryKernel).toHaveBeenCalledTimes(1);
    expect(window.__HERMES_RUNTIME__?.backendDegraded).toBe(false);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["kernel-status"] }));
  });

  it("仍降级时展示新的 lastError", async () => {
    installWindow(
      {
        retryKernel: vi.fn().mockResolvedValue({
          mode: "degraded",
          baseUrl: "http://127.0.0.1:9119",
          lastError: "端口 9119 仍被其它进程占用",
        }),
      },
      { backendDegraded: true, backendDegradedReason: "旧错误" },
    );
    vi.mocked(fetchJSON).mockResolvedValue({ version: "1.0", gateway_state: "running" } as never);

    await renderDegraded();
    fireEvent.click(screen.getByTestId("kernel-degraded-retry"));

    const result = await screen.findByTestId("kernel-retry-result");
    expect(result.textContent).toContain("端口 9119 仍被其它进程占用");
    expect(result.textContent).not.toBe("内核已启动");
    expect(window.__HERMES_RUNTIME__?.backendDegradedReason).toBe("端口 9119 仍被其它进程占用");
  });

  it("桌面端没有 retry_kernel 时退回 REST 重启", async () => {
    installWindow({}, {});
    vi.mocked(fetchJSON).mockResolvedValue({ version: "1.0", gateway_state: "running" } as never);
    vi.mocked(postJSON).mockResolvedValue({} as never);

    await renderDegraded();
    fireEvent.click(screen.getByTestId("kernel-degraded-retry"));

    await waitFor(() => {
      expect(vi.mocked(postJSON)).toHaveBeenCalledWith("/api/gateway/restart", {});
    });
    expect(screen.queryByTestId("kernel-retry-result")).toBeNull();
  });
});
