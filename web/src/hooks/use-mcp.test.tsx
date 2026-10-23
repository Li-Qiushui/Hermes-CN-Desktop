// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteJSON, putJSON, postJSON } = vi.hoisted(() => ({
  deleteJSON: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  putJSON: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  postJSON: vi.fn(async (): Promise<unknown> => ({ ok: true })),
}));

vi.mock("@/lib/transport", () => ({
  deleteJSON,
  fetchJSON: vi.fn(),
  postJSON,
  putJSON,
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => "e2e-director",
}));

import {
  useRemoveMcpServer,
  useSaveMcpRawServers,
  useSaveToolFilter,
  useTestMcpServer,
} from "./use-mcp";
import { readToolFilter, toggleToolInFilter } from "@/lib/mcp-tools";

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } });
}

describe("useRemoveMcpServer", () => {
  beforeEach(() => deleteJSON.mockClear());

  it("refreshes both installed servers and catalog installation state", async () => {
    const client = freshClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRemoveMcpServer(), {
      wrapper: wrapperFor(client),
    });

    await act(async () => {
      await result.current.mutateAsync("unreal-engine");
    });

    expect(deleteJSON).toHaveBeenCalledWith(
      "/api/mcp/servers/unreal-engine",
      undefined,
      expect.anything(),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["mcp-servers-full"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["mcp-catalog"] });
  });
});

describe("useSaveToolFilter", () => {
  beforeEach(() => putJSON.mockClear());

  it("PUTs only the exclude delta under mcp_servers", async () => {
    const client = freshClient();
    const { result } = renderHook(() => useSaveToolFilter(), { wrapper: wrapperFor(client) });
    const filter = toggleToolInFilter(
      readToolFilter({ exclude: ["list_dir"] }),
      ["read_file", "write_file", "list_dir"],
      "write_file",
      false,
    );

    await act(async () => {
      await result.current.mutateAsync({ name: "filesystem", filter });
    });

    expect(putJSON).toHaveBeenCalledTimes(1);
    const [path, body] = putJSON.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(path).toBe("/api/config");
    expect(body).toEqual({
      config: { mcp_servers: { filesystem: { tools: { exclude: ["write_file", "list_dir"] } } } },
    });
  });

  it("sends an empty exclude list when everything is re-enabled", async () => {
    const client = freshClient();
    const { result } = renderHook(() => useSaveToolFilter(), { wrapper: wrapperFor(client) });
    const filter = toggleToolInFilter(
      readToolFilter({ exclude: ["read_file"] }),
      ["read_file"],
      "read_file",
      true,
    );

    await act(async () => {
      await result.current.mutateAsync({ name: "fs", filter });
    });

    const [, body] = putJSON.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(body.config.mcp_servers.fs.tools.exclude).toEqual([]);
  });
});

describe("useSaveMcpRawServers", () => {
  beforeEach(() => putJSON.mockClear());

  it("replaces the whole map through the mcp.json endpoint", async () => {
    const client = freshClient();
    const { result } = renderHook(() => useSaveMcpRawServers(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ fs: { command: "npx", args: ["-y", "x"] } });
    });

    expect(putJSON).toHaveBeenCalledWith(
      "/api/mcp/servers",
      { servers: { fs: { command: "npx", args: ["-y", "x"] } } },
      expect.anything(),
    );
  });
});

describe("useTestMcpServer", () => {
  beforeEach(() => postJSON.mockClear());

  it("keeps the per-tool schema size the protocol schema would drop", async () => {
    postJSON.mockResolvedValueOnce({
      ok: true,
      prompts: 1,
      resources: 0,
      tools: [
        { name: "read_file", description: "read", schema_chars: 1200 },
        { name: "write_file", description: "write" },
      ],
    });
    const client = freshClient();
    const { result } = renderHook(() => useTestMcpServer(), { wrapper: wrapperFor(client) });

    const res = await act(async () => result.current.mutateAsync("filesystem"));

    expect(postJSON).toHaveBeenCalledWith("/api/mcp/servers/filesystem/test", {});
    expect(res?.tools[0].schema_chars).toBe(1200);
    expect(res?.tools[1].schema_chars).toBeUndefined();
    expect(res?.prompts).toBe(1);
  });

  it("normalizes an auth failure so the status machine can classify it", async () => {
    postJSON.mockResolvedValueOnce({ ok: false, error: "OAuth authentication required", tools: null });
    const client = freshClient();
    const { result } = renderHook(() => useTestMcpServer(), { wrapper: wrapperFor(client) });

    const res = await act(async () => result.current.mutateAsync("github"));

    expect(res?.ok).toBe(false);
    expect(res?.tools).toEqual([]);
    expect(res?.error).toContain("OAuth");
  });
});
