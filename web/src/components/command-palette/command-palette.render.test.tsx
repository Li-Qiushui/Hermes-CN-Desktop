// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { CommandPalette } from "./command-palette";
import { useSessionSearch, useSessions } from "@/hooks/use-sessions";
import { commandPaletteOpenAtom } from "@/stores/ui";

vi.mock("@/hooks/use-sessions", () => ({
  useSessions: vi.fn(),
  useSessionSearch: vi.fn(),
  stripSearchHighlight: (snippet: string | null | undefined) =>
    typeof snippet === "string" ? snippet.replace(/(>>>|<<<)/g, "").trim() : "",
}));

vi.mock("@/hooks/use-skills", () => ({
  useSkills: () => ({ data: [], isFetching: false }),
}));

vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn().mockResolvedValue({ entries: [] }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderPalette() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <CommandPalette />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  (globalThis as any).ResizeObserver = ResizeObserverStub;
  Element.prototype.scrollIntoView = vi.fn();
  getDefaultStore().set(commandPaletteOpenAtom, true);
  vi.mocked(useSessions).mockReturnValue({
    data: { sessions: [], total: 0, limit: 200, offset: 0 },
    isFetching: false,
  } as unknown as ReturnType<typeof useSessions>);
  vi.mocked(useSessionSearch).mockReturnValue({
    results: [],
    searchPending: false,
    debouncedQuery: "",
  } as unknown as ReturnType<typeof useSessionSearch>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CommandPalette 后端全文搜索", () => {
  it("把输入交给后端搜索钩子", async () => {
    renderPalette();

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "网关" } });

    await waitFor(() => expect(vi.mocked(useSessionSearch).mock.calls.at(-1)?.[0]).toBe("网关"));
  });

  it("后端命中的老会话出现在会话组里，点开跳详情页", async () => {
    vi.mocked(useSessionSearch).mockReturnValue({
      results: [{ session_id: "old-7", snippet: ">>>网关<<<配置的那次排查", title: "老会话" }],
      searchPending: false,
      debouncedQuery: "网关",
    } as unknown as ReturnType<typeof useSessionSearch>);

    renderPalette();
    fireEvent.change(screen.getByPlaceholderText(/搜索命令/), { target: { value: "网关" } });

    const hit = await screen.findByText("老会话");
    expect(hit).toBeTruthy();
    expect(screen.getByText("网关配置的那次排查")).toBeTruthy();
  });

  it("没有输入时不会把空结果塞进面板", () => {
    renderPalette();

    expect(screen.queryByText("老会话")).toBeNull();
    expect(vi.mocked(useSessionSearch).mock.calls.at(-1)?.[0]).toBe("");
  });
});
