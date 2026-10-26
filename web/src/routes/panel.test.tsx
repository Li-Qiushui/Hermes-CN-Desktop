/** @vitest-environment jsdom */
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@hermes/protocol";
import { activeSessionIdAtom } from "@/stores/ui";

const panelMocks = vi.hoisted(() => ({
  createEmptySession: vi.fn(),
  sessions: [] as SessionSummary[],
}));

vi.mock("@/hooks/use-create-and-send-session", () => ({
  useCreateEmptySession: () => panelMocks.createEmptySession,
  useCreateAndSendSession: () => vi.fn(),
}));

vi.mock("@/hooks/use-sessions", () => ({
  useSessions: () => ({
    data: { sessions: panelMocks.sessions },
    isLoading: false,
  }),
}));

vi.mock("@/components/panel/panel-composer", () => ({
  PanelComposer: () => <div data-panel-composer="true" />,
}));

vi.mock("@/components/panel/panel-hero", () => ({
  PanelHero: () => <div data-panel-hero="true" />,
}));

vi.mock("@/components/panel/health-grid", () => ({
  HealthGrid: () => <div data-health-grid="true" />,
}));

vi.mock("@/components/panel/quick-start", () => ({
  QuickStart: () => <div data-quick-start="true" />,
}));

vi.mock("@/components/panel/recent-table", () => ({
  RecentTable: () => <div data-recent-table="true" />,
}));

vi.mock("@/components/panel/task-card", () => ({
  TaskCard: () => <div data-task-card="true" />,
}));

import { PanelRoute } from "./panel";

let currentPath = "/";

function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

function summary(id: string, startedAt: number, title = id): SessionSummary {
  return {
    id,
    title,
    model: "model",
    started_at: startedAt,
    ended_at: startedAt,
    message_count: 2,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
  };
}

function renderPanel() {
  const view = render(
    <MemoryRouter initialEntries={["/"]}>
      <PathProbe />
      <PanelRoute />
    </MemoryRouter>,
  );
  const entries = view.container.querySelector('[data-new-chat-entries="inline"]');
  if (!entries) throw new Error("home page did not render the new-chat entries");
  return { ...view, entries: entries as HTMLElement };
}

beforeEach(() => {
  currentPath = "/";
  panelMocks.sessions = [summary("s-1", 100), summary("s-2", 300), summary("s-3", 200)];
  panelMocks.createEmptySession.mockReset();
  panelMocks.createEmptySession.mockResolvedValue("new-session");
  getDefaultStore().set(activeSessionIdAtom, null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PanelRoute new-chat entries", () => {
  it("shows both entries on the workbench home page", () => {
    const { entries } = renderPanel();
    expect(within(entries).getByText("新建空会话")).toBeTruthy();
    expect(within(entries).getByText("最近会话")).toBeTruthy();
    expect(within(entries).getByText("s-2")).toBeTruthy();
  });

  it("creates a blank session from the home page", async () => {
    const { entries } = renderPanel();
    fireEvent.click(within(entries).getByText("新建空会话"));
    await waitFor(() => expect(panelMocks.createEmptySession).toHaveBeenCalledTimes(1));
    expect(within(entries).getByText("新建空会话")).toBeTruthy();
  });

  it("reports a failed blank session inline on the home page", async () => {
    panelMocks.createEmptySession.mockRejectedValueOnce(new Error("网关没起来"));
    renderPanel();
    fireEvent.click(screen.getByText("新建空会话"));
    const error = await screen.findByText(/新建会话失败：网关没起来/);
    expect(error).toBeTruthy();
  });

  it("jumps into a recent session on a single click", async () => {
    const { entries } = renderPanel();
    fireEvent.click(within(entries).getByText("s-2"));
    await waitFor(() => expect(currentPath).toBe("/tasks/s-2"));
    expect(getDefaultStore().get(activeSessionIdAtom)).toBe("s-2");
  });

  it("keeps only the three newest sessions and drops the active one", () => {
    getDefaultStore().set(activeSessionIdAtom, "s-2");
    panelMocks.sessions = [
      summary("s-1", 100),
      summary("s-2", 300),
      summary("s-3", 200),
      summary("s-4", 500),
      summary("s-5", 400),
    ];
    const { entries } = renderPanel();
    const opened = within(entries)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("title") !== "直接开一个空会话，先配好模型再开口")
      .map((button) => button.getAttribute("title"));
    expect(opened).toEqual(["s-4", "s-5", "s-3"]);
  });
});
