// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ModelsSection } from "./settings-models-section";
import { __resetProviderModelsCacheForTests } from "@/hooks/use-provider-models";
import s from "./settings.module.css";

interface ConfigState {
  data: Record<string, unknown> | undefined;
  loading: boolean;
  error: Error | null;
}

const configState: ConfigState = { data: undefined, loading: true, error: null };
const listProviderModels = vi.fn();

vi.mock("@/hooks/use-config", () => ({
  useConfig: () => ({
    data: configState.data,
    isLoading: configState.loading,
    isError: configState.error !== null,
    error: configState.error,
    refetch: vi.fn(),
  }),
  useModelInfo: () => ({ data: { model: "deepseek-v4-flash", provider: "deepseek" } }),
  useSaveConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-env", () => ({
  useEnvVars: () => ({ data: {}, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useSetEnv: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteEnv: () => ({ mutate: vi.fn(), isPending: false }),
  useRevealEnv: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    probeProvider: vi.fn(),
    listProviderModels,
    setRuntimeModel: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-oauth-providers", () => ({
  useOAuthProviders: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/use-moa-config", () => ({
  useMoaConfig: () => ({ data: undefined }),
}));

vi.mock("@/lib/use-confirm", () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}));

vi.mock("@/lib/telemetry", () => ({ reportPromoClick: vi.fn() }));
vi.mock("@/lib/external-links", () => ({ openExternalUrl: vi.fn() }));
vi.mock("./settings-oauth-section", () => ({ OAuthProvidersSection: () => null }));
vi.mock("./settings-moa-panel", () => ({ MoaPanel: () => null }));

vi.mock("@/components/settings/model-combobox", () => ({
  ModelCombobox: ({ label, options, value }: { label: string; options: string[]; value: string }) => (
    <div data-testid={`combobox-${label}`} data-value={value}>
      {options.join("|")}
    </div>
  ),
}));

let queryClient = new QueryClient();

function tree() {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ModelsSection />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderModelsSection() {
  const view = render(tree());
  return {
    rerenderModelsSection: () => view.rerender(tree()),
  };
}

function modelComboboxOptions(): string {
  const node = screen.queryByTestId("combobox-模型");
  return node?.textContent ?? "";
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  configState.data = { model: "deepseek-v4-flash", provider: "deepseek" };
  configState.loading = true;
  configState.error = null;
  listProviderModels.mockReset();
  __resetProviderModelsCacheForTests();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ModelsSection", () => {
  it("keeps hook order stable when config finishes loading", async () => {
    const view = renderModelsSection();
    expect(screen.getByText("正在加载模型配置…")).toBeTruthy();

    configState.loading = false;
    act(() => {
      view.rerenderModelsSection();
    });

    await waitFor(() => expect(screen.queryByText("正在加载模型配置…")).toBeNull());
    expect(modelComboboxOptions()).toContain("deepseek-v4-flash");
  });

  it("degrades to the built-in catalog when the kernel has no provider.models", async () => {
    configState.loading = false;
    listProviderModels.mockRejectedValue(
      new Error(
        "unknown method: provider.models. the client and the Hermes backend are out of sync " +
          "(different versions); run 'hermes update' and restart both",
      ),
    );

    renderModelsSection();

    const refresh = await screen.findByRole("button", { name: /刷新模型列表|重试拉取|刷新失败/ });
    fireEvent.click(refresh);

    await waitFor(() =>
      expect(screen.getByText("当前内核不支持在线拉取模型列表，已按内置目录展示")).toBeTruthy(),
    );

    const pageText = document.body.textContent ?? "";
    expect(pageText).not.toContain("out of sync");
    expect(pageText).not.toContain("unknown method");
    expect(pageText).not.toContain("hermes update");

    expect(modelComboboxOptions()).toContain("deepseek-v4-flash");
    expect(modelComboboxOptions()).toContain("deepseek-v4-pro");
  });

  it("routes the kernel Chinese fallback notice to the hint slot, not the red error", async () => {
    configState.loading = false;
    listProviderModels.mockRejectedValue(new Error("当前内核不支持该功能（provider.models），已降级处理"));

    renderModelsSection();

    const refresh = await screen.findByRole("button", { name: /刷新模型列表|重试拉取|刷新失败/ });
    fireEvent.click(refresh);

    const notice = await screen.findByText("当前内核不支持在线拉取模型列表，已按内置目录展示");
    expect(notice.className).toBe(s.modelPickerHint);
    expect(notice.className).not.toBe(s.modelPickerError);
    expect(screen.getByRole("button", { name: /重试拉取/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /刷新失败 重试/ })).toBeNull();
  });

  it("still shows a real auth failure as the red error", async () => {
    configState.loading = false;
    listProviderModels.mockRejectedValue(new Error("API key rejected (HTTP 401)"));

    renderModelsSection();

    const refresh = await screen.findByRole("button", { name: /刷新模型列表|重试拉取|刷新失败/ });
    fireEvent.click(refresh);

    const notice = await screen.findByText("API Key 无效或未保存");
    expect(notice.className).toBe(s.modelPickerError);
    expect(await screen.findByRole("button", { name: /刷新失败 重试/ })).toBeTruthy();
  });

  it("keeps the last fetched list visible when a later refresh hits the missing method", async () => {
    configState.loading = false;
    listProviderModels.mockResolvedValue({
      ok: true,
      models: ["deepseek-chat-custom"],
      model_count: 1,
      status_code: 200,
      error: null,
      error_kind: null,
    });

    renderModelsSection();
    const refresh = await screen.findByRole("button", { name: /刷新模型列表/ });
    fireEvent.click(refresh);
    await waitFor(() => expect(modelComboboxOptions()).toContain("deepseek-chat-custom"));

    listProviderModels.mockRejectedValue(new Error("unknown method: provider.models"));
    fireEvent.click(screen.getByRole("button", { name: /已加载 1 个/ }));

    await waitFor(() =>
      expect(screen.getByText("当前内核不支持在线拉取模型列表，已按内置目录展示")).toBeTruthy(),
    );
    expect(modelComboboxOptions()).toContain("deepseek-chat-custom");
  });
});
