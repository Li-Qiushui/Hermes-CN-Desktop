// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { StatusChip } from "./status-chip";

vi.mock("@/lib/runtime", () => ({
  runtime: { isRemote: () => false, isBackendReady: () => false, isBackendDegraded: () => true },
}));

vi.mock("@/hooks/use-config", () => ({
  useModelInfo: () => ({
    data: { model: "deepseek-v4.1-flash", provider: "workbuddy", effective_context_length: 1_000_000 },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/use-status", () => ({
  useStatus: () => ({
    data: { version: "0.22.2", gateway_health_url: "http://127.0.0.1:9119/api/health" },
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-runtime-update", () => ({
  useRuntimeInfo: () => ({ data: undefined }),
}));

vi.mock("@/hooks/use-gateway-restart", () => ({
  useGatewayRestartAction: () => ({
    phase: "idle",
    message: null,
    busy: false,
    locked: false,
    restart: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { __HERMES_RUNTIME__?: unknown }).__HERMES_RUNTIME__;
});

describe("顶栏状态 chip · 内核降级", () => {
  it("降级时 chip 文案变成「内核异常」并在浮层里给出降级原因", async () => {
    window.__HERMES_RUNTIME__ = {
      platform: "tauri",
      backendReady: false,
      backendDegraded: true,
      backendDegradedReason: "spawn hermes serve 失败：找不到可执行文件",
    };

    render(
      <MemoryRouter>
        <StatusChip />
      </MemoryRouter>,
    );

    const chip = screen.getByRole("button", { name: /（本机内核）/ });
    expect(chip.textContent).toContain("内核异常");
    expect(chip.getAttribute("title")).toContain("已降级到手动连接");

    fireEvent.click(chip);

    await waitFor(() => expect(screen.getByText("内核异常（已降级）")).toBeTruthy());
    expect(screen.getByTestId("status-chip-degraded-reason").textContent).toContain("spawn hermes serve 失败");
  });
});
