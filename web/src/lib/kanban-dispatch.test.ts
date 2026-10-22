import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn(() => Promise.resolve({ dispatched: 0 })),
}));

import { fetchJSON } from "@/lib/transport";
import {
  KANBAN_DISPATCH_DEBOUNCE_MS,
  cancelKanbanDispatch,
  flushKanbanDispatch,
  kanbanDispatchPath,
  pendingKanbanDispatchCount,
  requestKanbanDispatch,
} from "./kanban-dispatch";

const fetchMock = vi.mocked(fetchJSON);

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockClear();
  fetchMock.mockResolvedValue({});
  cancelKanbanDispatch();
});

afterEach(() => {
  cancelKanbanDispatch();
  vi.useRealTimers();
});

describe("kanban dispatch 防抖", () => {
  it("400ms 内的多次写操作只 POST 一次 /dispatch", async () => {
    requestKanbanDispatch("default");
    await vi.advanceTimersByTimeAsync(200);
    requestKanbanDispatch("default");
    expect(pendingKanbanDispatchCount()).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(KANBAN_DISPATCH_DEBOUNCE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(kanbanDispatchPath("default"), { method: "POST" });
    expect(pendingKanbanDispatchCount()).toBe(0);
  });

  it("不同看板各自计时", async () => {
    requestKanbanDispatch("default");
    requestKanbanDispatch("other");
    await vi.advanceTimersByTimeAsync(KANBAN_DISPATCH_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      kanbanDispatchPath("default"),
      kanbanDispatchPath("other"),
    ]);
  });

  it("失败静默，不抛到调用方", async () => {
    fetchMock.mockRejectedValue(new Error("HTTP 500"));
    requestKanbanDispatch("default");
    await vi.advanceTimersByTimeAsync(KANBAN_DISPATCH_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("同步抛错也吞掉", async () => {
    fetchMock.mockImplementation(() => {
      throw new Error("version mismatch");
    });
    await expect(flushKanbanDispatch("default")).resolves.toBeUndefined();
  });

  it("cancel 之后不再发请求", async () => {
    requestKanbanDispatch("default");
    cancelKanbanDispatch();
    await vi.advanceTimersByTimeAsync(KANBAN_DISPATCH_DEBOUNCE_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
