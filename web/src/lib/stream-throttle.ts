export interface TailThrottle<T> {
  push(value: T): void;
  cancel(): void;
  flushNow(): void;
}

type ScheduleKind = "frame" | "timer";

interface FrameGlobals {
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
}

function currentNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function createTailThrottle<T>(
  flush: (value: T) => void,
  intervalMs = 60,
): TailThrottle<T> {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  let latest: T | undefined;
  let hasLatest = false;
  let lastFlushAt = Number.NEGATIVE_INFINITY;
  let kind: ScheduleKind | null = null;
  let handle: unknown = null;

  const clearScheduled = () => {
    if (kind === "frame") {
      const cancelFrame = (globalThis as FrameGlobals).cancelAnimationFrame;
      if (typeof cancelFrame === "function") cancelFrame(handle as number);
    } else if (kind === "timer") {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
    kind = null;
    handle = null;
  };

  const emit = () => {
    if (!hasLatest) return;
    const value = latest as T;
    hasLatest = false;
    latest = undefined;
    lastFlushAt = currentNow();
    flush(value);
  };

  const tick = () => {
    kind = null;
    handle = null;
    const remaining = interval - (currentNow() - lastFlushAt);
    if (remaining > 0) {
      kind = "timer";
      handle = setTimeout(tick, remaining);
      return;
    }
    emit();
  };

  const schedule = () => {
    if (kind !== null) return;
    const requestFrame = (globalThis as FrameGlobals).requestAnimationFrame;
    if (typeof requestFrame === "function") {
      kind = "frame";
      handle = requestFrame(tick);
      return;
    }
    kind = "timer";
    handle = setTimeout(tick, 0);
  };

  return {
    push(value: T) {
      latest = value;
      hasLatest = true;
      schedule();
    },
    cancel() {
      clearScheduled();
      hasLatest = false;
      latest = undefined;
    },
    flushNow() {
      clearScheduled();
      emit();
    },
  };
}
