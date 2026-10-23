import { useCallback, useEffect, useState } from "react";
import type { SessionSummary } from "@hermes/protocol";
import {
  STALL_WATCHDOG_THRESHOLD_MS,
  hasRunningTool,
  isRuntimeRunning,
  streamSilenceMs,
} from "@/lib/session-activity";
import { promptsOf, type ChatSessionRuntime } from "@/stores/chat";
import {
  readSidebarGrouping,
  readSidebarSort,
  readSidebarStatusFilter,
  resolveSessionDotState,
  subscribeSessionUiStateChanges,
  toggleStatusFilterBucket,
  writeSidebarGrouping,
  writeSidebarSort,
  writeSidebarStatusFilter,
  type SessionDotState,
  type SessionStatusBucket,
  type SidebarGrouping,
  type SidebarSortKey,
} from "@/lib/session-ui-state";

export interface RowDotInput {
  unread: boolean;
  now: number;
}

export type RowDotSession = Pick<SessionSummary, "id" | "message_count" | "preview" | "title">;

export function resolveRowDotState(
  session: RowDotSession,
  runtime: ChatSessionRuntime | undefined,
  { unread, now }: RowDotInput,
): SessionDotState {
  const needsInput = runtime ? promptsOf(runtime).length > 0 : false;
  const working = isRuntimeRunning(runtime);
  const silenceMs = streamSilenceMs(runtime, now);
  const stalled = working && silenceMs !== null && silenceMs >= STALL_WATCHDOG_THRESHOLD_MS;
  const background = !working && runtime !== undefined ? hasRunningTool(runtime) : false;
  const draft = (session.message_count ?? 0) === 0 && !session.title && !session.preview;
  return resolveSessionDotState({ needsInput, working, stalled, background, unread, draft });
}

export interface SidebarListState {
  sort: SidebarSortKey;
  grouping: SidebarGrouping;
  statusFilter: SessionStatusBucket[];
  setSort: (key: SidebarSortKey) => void;
  setGrouping: (grouping: SidebarGrouping) => void;
  toggleStatus: (bucket: SessionStatusBucket) => void;
  clearStatus: () => void;
}

export function useSidebarListState(): SidebarListState {
  const [sort, setSortState] = useState<SidebarSortKey>(readSidebarSort);
  const [grouping, setGroupingState] = useState<SidebarGrouping>(readSidebarGrouping);
  const [statusFilter, setStatusFilter] = useState<SessionStatusBucket[]>(readSidebarStatusFilter);

  useEffect(
    () =>
      subscribeSessionUiStateChanges(() => {
        setSortState(readSidebarSort());
        setGroupingState(readSidebarGrouping());
        setStatusFilter(readSidebarStatusFilter());
      }),
    [],
  );

  const setSort = useCallback((key: SidebarSortKey) => setSortState(writeSidebarSort(key)), []);
  const setGrouping = useCallback(
    (next: SidebarGrouping) => setGroupingState(writeSidebarGrouping(next)),
    [],
  );
  const toggleStatus = useCallback(
    (bucket: SessionStatusBucket) =>
      setStatusFilter(toggleStatusFilterBucket(readSidebarStatusFilter(), bucket)),
    [],
  );
  const clearStatus = useCallback(() => setStatusFilter(writeSidebarStatusFilter([])), []);

  return { sort, grouping, statusFilter, setSort, setGrouping, toggleStatus, clearStatus };
}
