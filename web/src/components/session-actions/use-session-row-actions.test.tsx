// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { SessionSummary } from "@hermes/protocol";
import type { DeleteSessionsResult } from "@/hooks/use-sessions";
import { useSessionRowActions, type UseSessionRowActionsOptions } from "./use-session-row-actions";
import { clearSessionDeleteNotice } from "./session-delete-notice";

afterEach(() => {
  cleanup();
  clearSessionDeleteNotice();
});

function makeSession(id: string): SessionSummary {
  return {
    id,
    title: id,
    model: "fake-model",
    source: "web",
    started_at: 1700000000,
    ended_at: 1700000060,
    end_reason: "done",
    message_count: 1,
    input_tokens: 1,
    output_tokens: 1,
    estimated_cost_usd: null,
  };
}

function result(partial: Partial<DeleteSessionsResult> = {}): DeleteSessionsResult {
  return {
    requestedIds: [],
    succeededIds: [],
    failed: [],
    successCount: 0,
    failureCount: 0,
    ...partial,
  };
}

function makeProps(overrides: Partial<UseSessionRowActionsOptions> = {}): UseSessionRowActionsOptions {
  return {
    deleteSessions: vi.fn(async (ids: string[]) =>
      result({ requestedIds: ids, succeededIds: ids, successCount: ids.length }),
    ),
    isDeleting: false,
    setSessionTitle: vi.fn(async (): Promise<string | undefined> => undefined),
    resumeSession: vi.fn(async (): Promise<string> => "sess-resumed"),
    archive: vi.fn(),
    ...overrides,
  };
}

function notice(): HTMLElement | null {
  return document.querySelector('[role="status"]');
}

describe("useSessionRowActions delete", () => {
  it("全部成功时关窗并回传成功 id", async () => {
    const onDeleted = vi.fn();
    const { result: hook } = renderHook(() => useSessionRowActions(makeProps({ onDeleted })));

    act(() => hook.current.openDeleteDialog([makeSession("s1"), makeSession("s2")]));
    await act(async () => {
      await hook.current.confirmDelete();
    });

    expect(hook.current.deleteTargets).toBeNull();
    expect(hook.current.deleteError).toBe("");
    expect(onDeleted).toHaveBeenCalledWith(["s1", "s2"]);
    expect(notice()).toBeNull();
  });

  it("部分成功时照样关窗，失败项走弹窗外的提示", async () => {
    const onDeleted = vi.fn();
    const deleteSessions = vi.fn(async (ids: string[]) =>
      result({
        requestedIds: ids,
        succeededIds: ["idle-1"],
        failed: [{ id: "running-2", error: "HTTP 409: runtime_revision_conflict" }],
        successCount: 1,
        failureCount: 1,
      }),
    );
    const { result: hook } = renderHook(() =>
      useSessionRowActions(makeProps({ deleteSessions, onDeleted })),
    );

    act(() => hook.current.openDeleteDialog([makeSession("idle-1"), makeSession("running-2")]));
    await act(async () => {
      await hook.current.confirmDelete();
    });

    expect(hook.current.deleteTargets).toBeNull();
    expect(hook.current.deleteError).toBe("");
    expect(onDeleted).toHaveBeenCalledWith(["idle-1"]);
    const node = notice();
    expect(node?.textContent).toContain("1 个删除失败");
    expect(node?.textContent).toContain("HTTP 409: runtime_revision_conflict");
  });

  it("全失败时留着弹窗并把后端原文显示出来", async () => {
    const onDeleted = vi.fn();
    const deleteSessions = vi.fn(async (ids: string[]) =>
      result({
        requestedIds: ids,
        failed: [
          { id: "running-1", error: "HTTP 409: runtime_revision_conflict" },
          { id: "running-2", error: "HTTP 409: runtime_revision_conflict" },
        ],
        failureCount: 2,
      }),
    );
    const { result: hook } = renderHook(() =>
      useSessionRowActions(makeProps({ deleteSessions, onDeleted })),
    );

    act(() => hook.current.openDeleteDialog([makeSession("running-1"), makeSession("running-2")]));
    await act(async () => {
      await hook.current.confirmDelete();
    });

    expect(hook.current.deleteTargets).toHaveLength(2);
    expect(hook.current.deleteError).toContain("2 个会话删除失败");
    expect(hook.current.deleteError).toContain("HTTP 409");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it("整批调用 reject 时按全失败处理，不关窗", async () => {
    const deleteSessions = vi.fn(async () => {
      throw new Error("HTTP 500: kernel exploded");
    });
    const { result: hook } = renderHook(() => useSessionRowActions(makeProps({ deleteSessions })));

    act(() => hook.current.openDeleteDialog([makeSession("s1")]));
    await act(async () => {
      await hook.current.confirmDelete();
    });

    expect(hook.current.deleteTargets).toHaveLength(1);
    expect(hook.current.deleteError).toContain("HTTP 500: kernel exploded");
  });

  it("删除进行中不许关窗，请求结束后恢复可关", async () => {
    let release: ((value: DeleteSessionsResult) => void) | null = null;
    const deleteSessions = vi.fn(
      () =>
        new Promise<DeleteSessionsResult>((resolve) => {
          release = resolve;
        }),
    );
    const { result: hook } = renderHook(() => useSessionRowActions(makeProps({ deleteSessions })));

    act(() => hook.current.openDeleteDialog([makeSession("s1")]));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.current.confirmDelete();
    });

    expect(hook.current.isDeleting).toBe(true);
    act(() => hook.current.closeDeleteDialog());
    expect(hook.current.deleteTargets).toHaveLength(1);

    await act(async () => {
      release?.(result({ requestedIds: ["s1"], succeededIds: ["s1"], successCount: 1 }));
      await pending;
    });

    expect(hook.current.isDeleting).toBe(false);
    expect(hook.current.deleteTargets).toBeNull();
  });

  it("调用方的 isDeleting 卡住时不阻塞关窗路径", async () => {
    const deleteSessions = vi.fn(async (ids: string[]) =>
      result({
        requestedIds: ids,
        failed: [{ id: "running-1", error: "HTTP 409: conflict" }],
        failureCount: 1,
      }),
    );
    const { result: hook, rerender } = renderHook(() =>
      useSessionRowActions(makeProps({ deleteSessions })),
    );

    act(() => hook.current.openDeleteDialog([makeSession("running-1")]));
    await act(async () => {
      await hook.current.confirmDelete();
    });
    expect(hook.current.deleteTargets).toHaveLength(1);

    rerender();
    act(() => hook.current.closeDeleteDialog());
    expect(hook.current.deleteTargets).toBeNull();
    expect(hook.current.deleteError).toBe("");
  });
});
