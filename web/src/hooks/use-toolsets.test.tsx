// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { putJSON } = vi.hoisted(() => ({
  putJSON: vi.fn(async () => ({ ok: true, name: "kanban", platform: "cli", enabled: true, post_setup_started: null })),
}));

vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn(),
  putJSON,
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => "default",
}));

import { TOOLSETS_QUERY_KEY, toolsetsQueryKey, useToggleToolset } from "./use-toolsets";
import type { ToolsetInfo } from "@/lib/toolsets";

const SEED: ToolsetInfo[] = [
  {
    name: "kanban",
    label: "Kanban",
    description: "opt-in task board tools",
    platform: "cli",
    platform_label: "CLI",
    enabled: false,
    available: false,
    configured: true,
    tools: ["kanban_create"],
  },
  {
    name: "web",
    label: "Web",
    description: "web_search, web_extract",
    platform: "cli",
    platform_label: "CLI",
    enabled: true,
    available: true,
    configured: true,
    tools: ["web_search"],
  },
];

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData<ToolsetInfo[]>(toolsetsQueryKey("default"), SEED);
  return client;
}

describe("useToggleToolset", () => {
  beforeEach(() => putJSON.mockClear());

  it("writes the toggle back to the kernel config endpoint", async () => {
    const client = newClient();
    const { result } = renderHook(() => useToggleToolset(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ name: "kanban", enabled: true });
    });

    expect(putJSON).toHaveBeenCalledWith("/api/tools/toolsets/kanban", { enabled: true });
  });

  it("applies the flip optimistically before the request settles", async () => {
    const client = newClient();
    let resolveRequest: () => void = () => {};
    putJSON.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = () =>
            resolve({ ok: true, name: "kanban", platform: "cli", enabled: true, post_setup_started: null });
        }),
    );

    const { result } = renderHook(() => useToggleToolset(), { wrapper: wrapperFor(client) });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.mutateAsync({ name: "kanban", enabled: true });
    });

    // onMutate 先 await cancelQueries，乐观写入晚一个微任务落缓存
    await act(async () => {
      await Promise.resolve();
    });

    const optimistic = client.getQueryData<ToolsetInfo[]>(toolsetsQueryKey("default"));
    const kanban = optimistic?.find((row) => row.name === "kanban");
    expect(kanban?.enabled).toBe(true);
    expect(kanban?.available).toBe(true);
    expect(optimistic?.find((row) => row.name === "web")?.enabled).toBe(true);

    await act(async () => {
      resolveRequest();
      await pending;
    });
  });

  it("rolls the row back and rethrows when the write fails", async () => {
    const client = newClient();
    putJSON.mockRejectedValueOnce(new Error("HTTP 500: config write failed"));

    const { result } = renderHook(() => useToggleToolset(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await expect(result.current.mutateAsync({ name: "kanban", enabled: true })).rejects.toThrow(
        "config write failed",
      );
    });

    const rows = client.getQueryData<ToolsetInfo[]>(toolsetsQueryKey("default"));
    const kanban = rows?.find((row) => row.name === "kanban");
    expect(kanban?.enabled).toBe(false);
    expect(kanban?.available).toBe(false);
    expect(rows?.find((row) => row.name === "web")?.enabled).toBe(true);
  });

  it("invalidates the toolsets list so the next read reconciles", async () => {
    const client = newClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useToggleToolset(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ name: "web", enabled: false });
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: [TOOLSETS_QUERY_KEY] });
  });
});
