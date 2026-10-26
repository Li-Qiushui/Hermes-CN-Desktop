/** @vitest-environment jsdom */
import { MemoryRouter, useLocation } from "react-router-dom";
import { act, renderHook } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateEmptySession } from "./use-create-and-send-session";
import { activeSessionIdAtom } from "@/stores/ui";

const gatewayMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({ createSession: gatewayMocks.createSession }),
}));

let currentPath = "/";

function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <PathProbe />
      {children}
    </MemoryRouter>
  );
}

beforeEach(() => {
  currentPath = "/";
  gatewayMocks.createSession.mockReset();
  gatewayMocks.createSession.mockResolvedValue("session-new");
  getDefaultStore().set(activeSessionIdAtom, null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCreateEmptySession", () => {
  it("opens a session without sending a prompt", async () => {
    const { result } = renderHook(() => useCreateEmptySession(), { wrapper });
    const id = await act(async () => result.current());

    expect(id).toBe("session-new");
    expect(gatewayMocks.createSession).toHaveBeenCalledTimes(1);
    expect(gatewayMocks.createSession).toHaveBeenCalledWith({ cwd: undefined });
    expect(currentPath).toBe("/tasks/session-new");
    expect(getDefaultStore().get(activeSessionIdAtom)).toBe("session-new");
  });

  it("passes the workspace and thinking effort through when asked", async () => {
    const { result } = renderHook(() => useCreateEmptySession(), { wrapper });
    await act(async () => result.current({ cwd: "  D:/Project/demo  ", reasoningEffort: "high" }));

    expect(gatewayMocks.createSession).toHaveBeenCalledWith({
      cwd: "D:/Project/demo",
      reasoningEffort: "high",
    });
  });

  it("surfaces a failed create instead of navigating into a dead session", async () => {
    gatewayMocks.createSession.mockRejectedValueOnce(new Error("内核未就绪"));
    const { result } = renderHook(() => useCreateEmptySession(), { wrapper });

    await expect(act(async () => result.current())).rejects.toThrow("内核未就绪");
    expect(currentPath).toBe("/");
    expect(getDefaultStore().get(activeSessionIdAtom)).toBeNull();
  });
});
