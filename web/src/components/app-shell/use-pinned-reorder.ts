import { useCallback } from "react";
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { readPinnedSessionIds, reorderPinnedSessionIds } from "@/lib/session-ui-state";

export function applyPinnedReorder(
  activeId: string | null | undefined,
  overId: string | null | undefined,
): Set<string> | null {
  const from = (activeId ?? "").trim();
  const to = (overId ?? "").trim();
  if (!from || !to || from === to) return null;
  const before = Array.from(readPinnedSessionIds());
  const next = reorderPinnedSessionIds(from, to);
  const after = Array.from(next);
  if (before.length !== after.length) return null;
  if (before.every((id, index) => id === after[index])) return null;
  return next;
}

export interface PinnedReorderOptions {
  enabled: boolean;
  onReorder: (next: Set<string>) => void;
}

export function usePinnedReorder({ enabled, onReorder }: PinnedReorderOptions) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!enabled) return;
      const next = applyPinnedReorder(
        event.active ? String(event.active.id) : null,
        event.over ? String(event.over.id) : null,
      );
      if (next) onReorder(next);
    },
    [enabled, onReorder],
  );

  return { sensors, handleDragEnd, reorderEnabled: enabled };
}
