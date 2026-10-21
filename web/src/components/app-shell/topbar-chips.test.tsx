// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConnectionChip } from "./connection-chip";
import { ModelChip } from "./model-chip";

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
  it("模型卡显示短模型名与上下文，点击进入 配置 · 模型", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<ModelChip />} />
          <Route path="/models" element={<div>models-page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const chip = screen.getByRole("button", { name: /模型 deepseek-v4.1-flash，上下文 1M/ });
    expect(chip.textContent).toContain("deepseek-v4.1-flash");
    expect(chip.textContent).toContain("1M");

    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByText("models-page")).toBeTruthy());
  });

  it("连接卡显示模式与端口，点开是连接详情与两个动作", async () => {
    render(
      <MemoryRouter>
        <ConnectionChip />
      </MemoryRouter>,
    );

    const chip = screen.getByRole("button", { name: /外部 Hermes 连接/ });
    expect(chip.textContent).toContain("外部");
    expect(chip.textContent).toContain("9119");

    fireEvent.click(chip);

    await waitFor(() => expect(screen.getByText("健康检查")).toBeTruthy());
    expect(screen.getByText("重连网关")).toBeTruthy();
    expect(screen.getByText("http://localhost:9119/")).toBeTruthy();
    expect(screen.getByText("正常")).toBeTruthy();
    expect(screen.getByText("内核")).toBeTruthy();
    expect(screen.getByText("界面")).toBeTruthy();
  });
});
