// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { DragEndEvent } from "@dnd-kit/core";
import { applyPinnedReorder, usePinnedReorder } from "./use-pinned-reorder";
import {
  readPinnedSessionIds,
  writePinnedSessionIds,
} from "@/lib/session-ui-state";
import { __resetUiStoreForTests } from "@/lib/ui-store";

function dragEnd(activeId: string, overId: string | null): DragEndEvent {
  return {
    active: { id: activeId },
    over: overId ? { id: overId } : null,
  } as unknown as DragEndEvent;
}

describe("置顶拖拽换序", () => {
  it("按 over 的位置重排并写回 ui-store", () => {
    __resetUiStoreForTests();
    writePinnedSessionIds(["a", "b", "c"]);

    const next = applyPinnedReorder("c", "a");

    expect(next ? Array.from(next) : null).toEqual(["c", "a", "b"]);
    expect(Array.from(readPinnedSessionIds())).toEqual(["c", "a", "b"]);
  });

  it("原地放回或拖到不存在的项时不写", () => {
    __resetUiStoreForTests();
    writePinnedSessionIds(["a", "b"]);

    expect(applyPinnedReorder("a", "a")).toBeNull();
    expect(applyPinnedReorder("a", null)).toBeNull();
    expect(applyPinnedReorder("a", "zzz")).toBeNull();
    expect(Array.from(readPinnedSessionIds())).toEqual(["a", "b"]);
  });

  it("拖动结束时把新顺序交给上层", () => {
    __resetUiStoreForTests();
    writePinnedSessionIds(["a", "b", "c"]);
    const onReorder = vi.fn();
    const { result } = renderHook(() => usePinnedReorder({ enabled: true, onReorder }));

    act(() => result.current.handleDragEnd(dragEnd("a", "c")));

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(Array.from(onReorder.mock.calls[0][0] as Set<string>)).toEqual(["b", "c", "a"]);
    expect(Array.from(readPinnedSessionIds())).toEqual(["b", "c", "a"]);
  });

  it("排序键不是「最近更新」时禁用拖拽，顺序不动", () => {
    __resetUiStoreForTests();
    writePinnedSessionIds(["a", "b"]);
    const onReorder = vi.fn();
    const { result } = renderHook(() => usePinnedReorder({ enabled: false, onReorder }));

    act(() => result.current.handleDragEnd(dragEnd("a", "b")));

    expect(onReorder).not.toHaveBeenCalled();
    expect(Array.from(readPinnedSessionIds())).toEqual(["a", "b"]);
  });
});
