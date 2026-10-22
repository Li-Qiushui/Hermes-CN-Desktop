// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { StatusChip } from "./status-chip";

vi.mock("@/lib/runtime", () => ({
  runtime: { isRemote: () => false, isBackendReady: () => true },
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
    data: {
      version: "0.22.2",
      gateway_health_url: "http://127.0.0.1:9119/api/health",
    },
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
});

describe("顶栏状态 chip", () => {
  it("一枚 chip 同时显示端口、模型名与上下文", () => {
    render(
      <MemoryRouter>
        <StatusChip />
      </MemoryRouter>,
    );

    const chip = screen.getByRole("button", { name: /外部 Hermes 连接/ });
    expect(chip.textContent).toContain("9119");
    expect(chip.textContent).toContain("deepseek-v4.1-flash");
    expect(chip.textContent).toContain("1M");
  });

  it("点开是连接详情、模型信息与两个动作", async () => {
    render(
      <MemoryRouter>
        <StatusChip />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /外部 Hermes 连接/ }));

    await waitFor(() => expect(screen.getByText("健康检查")).toBeTruthy());
    expect(screen.getByText("重连网关")).toBeTruthy();
    expect(screen.getByText("http://localhost:9119/")).toBeTruthy();
    expect(screen.getByText("正常")).toBeTruthy();
    expect(screen.getByText("内核")).toBeTruthy();
    expect(screen.getByText("界面")).toBeTruthy();
    expect(screen.getByText("上下文")).toBeTruthy();
    expect(screen.getByText("打开 配置 · 模型")).toBeTruthy();
  });

  it("浮层里的模型入口跳到 配置 · 模型", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<StatusChip />} />
          <Route path="/models" element={<div>models-page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /外部 Hermes 连接/ }));
    const link = await waitFor(() => screen.getByText("打开 配置 · 模型"));
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByText("models-page")).toBeTruthy());
  });
});
