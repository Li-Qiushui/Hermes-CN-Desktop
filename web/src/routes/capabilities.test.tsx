// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ToolsetInfo } from "@/lib/toolsets";

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  refetch: vi.fn(),
  data: [] as unknown[],
  isError: false,
  isLoading: false,
}));

vi.mock("@/hooks/use-toolsets", () => ({
  useToolsets: () => ({
    data: h.data,
    isError: h.isError,
    isLoading: h.isLoading,
    isFetching: false,
    refetch: h.refetch,
  }),
  useToggleToolset: () => ({ mutate: h.mutate, isPending: false, variables: undefined }),
}));

import { CapabilitiesRoute } from "./capabilities";

function makeToolset(partial: Partial<ToolsetInfo> & { name: string }): ToolsetInfo {
  return {
    label: partial.name,
    description: "",
    platform: "cli",
    platform_label: "CLI",
    enabled: false,
    available: false,
    configured: true,
    tools: [],
    ...partial,
  };
}

const ROWS: ToolsetInfo[] = [
  makeToolset({ name: "web", label: "Web Search", enabled: true, tools: ["web_search", "web_extract"] }),
  makeToolset({ name: "kanban", label: "Kanban", description: "opt-in task board tools", tools: ["kanban_create"] }),
  makeToolset({ name: "vision", label: "Vision", tools: ["vision_analyze"] }),
  makeToolset({ name: "memory", label: "Memory", tools: ["memory"] }),
  makeToolset({ name: "discord", label: "Discord" }),
];

function renderPage() {
  h.data = ROWS;
  return render(
    <MemoryRouter>
      <CapabilitiesRoute />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  h.mutate.mockReset();
});

describe("CapabilitiesRoute", () => {
  it("groups toolsets and hides platform-coupled ones", () => {
    renderPage();

    expect(screen.getByText("工作")).toBeTruthy();
    expect(screen.getByText("创作")).toBeTruthy();
    expect(screen.getByText("记忆与检索")).toBeTruthy();
    expect(screen.queryByText("其他")).toBeNull();
    expect(screen.getByText("Kanban")).toBeTruthy();
    expect(screen.queryByText("Discord")).toBeNull();
  });

  it("shows the toolset slug, tool count and configured tag", () => {
    renderPage();

    expect(screen.getAllByText("kanban").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 个工具").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已配置").length).toBeGreaterThan(0);
  });

  it("reveals the tool names when a row is expanded", () => {
    renderPage();

    expect(screen.queryByText(/kanban_create/)).toBeNull();
    fireEvent.click(screen.getByText("opt-in task board tools"));

    expect(screen.getByText(/kanban_create/)).toBeTruthy();
  });

  it("writes a toggle back through the hook when the switch is clicked", () => {
    renderPage();

    fireEvent.click(screen.getByRole("switch", { name: "启用Kanban" }));

    expect(h.mutate).toHaveBeenCalledWith(
      { name: "kanban", enabled: true },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("filters by tool name", () => {
    renderPage();

    fireEvent.change(screen.getByLabelText("搜索工具集"), { target: { value: "web_extract" } });

    expect(screen.getByText("Web Search")).toBeTruthy();
    expect(screen.queryByText("Kanban")).toBeNull();
    expect(screen.queryByText("Vision")).toBeNull();
  });
});
