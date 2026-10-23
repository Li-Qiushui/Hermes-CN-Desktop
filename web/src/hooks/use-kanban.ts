import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteJSON, fetchJSON, patchJSON, postJSON } from "@/lib/transport";
import { requestKanbanDispatch } from "@/lib/kanban-dispatch";
import { uploadKanbanAttachment } from "@/lib/kanban-upload";
import type { KanbanUploadResult } from "@/lib/kanban-upload";
import {
  attachmentDeletePath,
  attachmentUploadPath,
  buildArchiveBoardPath,
  buildLinkBody,
  buildReassignBody,
} from "@/lib/kanban-orchestration";
import type {
  KanbanAssigneesResponse,
  KanbanBoardResponse,
  KanbanBoardView,
  KanbanBoardsResponse,
  KanbanBulkResponse,
  KanbanDecomposeResponse,
  KanbanDiagnosticsResponse,
  KanbanProfilesResponse,
  KanbanReassignResponse,
  KanbanTask,
  KanbanTaskDetailResponse,
  KanbanTaskLogResponse,
  KanbanWorkflowResponse,
} from "@/lib/kanban";

export const kanbanKeys = {
  boards: ["kanban", "boards"] as const,
  workflow: ["kanban", "workflow"] as const,
  assignees: ["kanban", "assignees"] as const,
  profiles: ["kanban", "profiles"] as const,
  boardAll: (slug: string) => ["kanban", "board", slug] as const,
  board: (slug: string, view: KanbanBoardView = "active") => ["kanban", "board", slug, view] as const,
  task: (slug: string, id: string) => ["kanban", "task", slug, id] as const,
  taskLog: (slug: string, id: string) => ["kanban", "task", slug, id, "log"] as const,
  diagnostics: (slug: string) => ["kanban", "diagnostics", slug] as const,
};

function boardQuery(slug: string): string {
  return `board=${encodeURIComponent(slug || "default")}`;
}

export function useKanbanBoards() {
  return useQuery<KanbanBoardsResponse>({
    queryKey: kanbanKeys.boards,
    queryFn: ({ signal }) => fetchJSON<KanbanBoardsResponse>("/api/plugins/kanban/boards", { signal }),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useKanbanWorkflow() {
  return useQuery<KanbanWorkflowResponse>({
    queryKey: kanbanKeys.workflow,
    queryFn: ({ signal }) => fetchJSON<KanbanWorkflowResponse>("/api/plugins/kanban/workflow", { signal }),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useKanbanAssignees() {
  return useQuery<KanbanAssigneesResponse>({
    queryKey: kanbanKeys.assignees,
    queryFn: ({ signal }) => fetchJSON<KanbanAssigneesResponse>("/api/plugins/kanban/assignees", { signal }),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useKanbanBoard(slug: string, view: KanbanBoardView = "active") {
  const archived = view === "archived";
  return useQuery<KanbanBoardResponse>({
    queryKey: kanbanKeys.board(slug, view),
    queryFn: ({ signal }) =>
      fetchJSON<KanbanBoardResponse>(
        `/api/plugins/kanban/board?${boardQuery(slug)}${archived ? "&include_archived=true" : ""}`,
        { signal },
      ),
    staleTime: 15_000,
    retry: 1,
  });
}

export function useKanbanTask(slug: string, taskId: string | null) {
  return useQuery<KanbanTaskDetailResponse>({
    queryKey: kanbanKeys.task(slug, taskId ?? ""),
    queryFn: ({ signal }) =>
      fetchJSON<KanbanTaskDetailResponse>(
        `/api/plugins/kanban/tasks/${encodeURIComponent(taskId ?? "")}?${boardQuery(slug)}`,
        { signal },
      ),
    enabled: Boolean(taskId),
    staleTime: 15_000,
    retry: 1,
  });
}

export const KANBAN_LOG_TAIL_BYTES = 16384;

export function useKanbanTaskLog(slug: string, taskId: string | null, enabled: boolean) {
  return useQuery<KanbanTaskLogResponse>({
    queryKey: kanbanKeys.taskLog(slug, taskId ?? ""),
    queryFn: ({ signal }) =>
      fetchJSON<KanbanTaskLogResponse>(
        `/api/plugins/kanban/tasks/${encodeURIComponent(taskId ?? "")}/log?${boardQuery(slug)}&tail=${KANBAN_LOG_TAIL_BYTES}`,
        { signal },
      ),
    enabled: Boolean(taskId) && enabled,
    staleTime: 5_000,
    retry: 0,
  });
}

export function useKanbanDiagnostics(slug: string, enabled: boolean) {
  return useQuery<KanbanDiagnosticsResponse>({
    queryKey: kanbanKeys.diagnostics(slug),
    queryFn: ({ signal }) =>
      fetchJSON<KanbanDiagnosticsResponse>(`/api/plugins/kanban/diagnostics?${boardQuery(slug)}`, { signal }),
    enabled,
    staleTime: 15_000,
    retry: 1,
  });
}

export interface UpdateKanbanTaskInput {
  id: string;
  body: Record<string, unknown>;
}

export function useUpdateKanbanTask(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<KanbanTaskDetailResponse, Error, UpdateKanbanTaskInput>({
    mutationFn: ({ id, body }) =>
      patchJSON<KanbanTaskDetailResponse>(
        `/api/plugins/kanban/tasks/${encodeURIComponent(id)}?${boardQuery(slug)}`,
        body,
      ),
    onSuccess: (result, variables) => {
      queryClient.setQueryData<KanbanTaskDetailResponse>(
        kanbanKeys.task(slug, variables.id),
        result,
      );
      queryClient.setQueriesData<KanbanBoardResponse>({ queryKey: kanbanKeys.boardAll(slug) }, (previous) => {
        if (!previous || !result?.task) return previous;
        const status = result.task.status;
        let moved: KanbanTask | null = null;
        const columns = previous.columns.map((column) => {
          const tasks: KanbanTask[] = [];
          for (const item of column.tasks) {
            if (item.id === variables.id) moved = { ...item, ...result.task };
            else tasks.push(item);
          }
          return { ...column, tasks };
        });
        if (!moved) return previous;
        return {
          ...previous,
          columns: columns.map((column) =>
            column.name === status
              ? { ...column, tasks: [{ ...(moved as KanbanTask) }, ...column.tasks] }
              : column,
          ),
        };
      });
      requestKanbanDispatch(slug);
    },
  });
}

export interface CreateKanbanTaskInput {
  title: string;
  body?: string;
  assignee?: string;
  priority?: number;
}

export function useCreateKanbanTask(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<KanbanTaskDetailResponse, Error, CreateKanbanTaskInput>({
    mutationFn: (input) =>
      postJSON<KanbanTaskDetailResponse>(`/api/plugins/kanban/tasks?${boardQuery(slug)}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boardAll(slug) });
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boards });
      requestKanbanDispatch(slug);
    },
  });
}

export function useDeleteKanbanTask(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) =>
      deleteJSON(`/api/plugins/kanban/tasks/${encodeURIComponent(id)}?${boardQuery(slug)}`),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: kanbanKeys.task(slug, id) });
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boardAll(slug) });
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boards });
      requestKanbanDispatch(slug);
    },
  });
}

export interface AddKanbanCommentInput {
  taskId: string;
  body: string;
}

export function useAddKanbanComment(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, AddKanbanCommentInput>({
    mutationFn: ({ taskId, body }) =>
      postJSON<unknown>(
        `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}/comments?${boardQuery(slug)}`,
        { body, author: "dashboard" },
      ),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: kanbanKeys.task(slug, variables.taskId) });
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boardAll(slug) });
    },
  });
}

export interface BulkKanbanTasksInput {
  ids: string[];
  patch: Record<string, unknown>;
}

export function useBulkKanbanTasks(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<KanbanBulkResponse, Error, BulkKanbanTasksInput>({
    mutationFn: ({ ids, patch }) =>
      postJSON<KanbanBulkResponse>(`/api/plugins/kanban/tasks/bulk?${boardQuery(slug)}`, { ids, ...patch }),
    onSuccess: (_result, variables) => {
      for (const id of variables.ids) {
        queryClient.invalidateQueries({ queryKey: kanbanKeys.task(slug, id) });
      }
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boardAll(slug) });
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boards });
      requestKanbanDispatch(slug);
    },
  });
}

export function useKanbanProfiles() {
  return useQuery<KanbanProfilesResponse>({
    queryKey: kanbanKeys.profiles,
    queryFn: ({ signal }) => fetchJSON<KanbanProfilesResponse>("/api/plugins/kanban/profiles", { signal }),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

function invalidateTaskGraph(queryClient: ReturnType<typeof useQueryClient>, slug: string, taskId: string): void {
  queryClient.invalidateQueries({ queryKey: kanbanKeys.task(slug, taskId) });
  queryClient.invalidateQueries({ queryKey: kanbanKeys.boardAll(slug) });
  queryClient.invalidateQueries({ queryKey: kanbanKeys.diagnostics(slug) });
}

export interface AddKanbanLinkInput {
  parentId: string;
  childId: string;
  taskId: string;
}

export function useAddKanbanLink(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean; gated?: unknown }, Error, AddKanbanLinkInput>({
    mutationFn: ({ parentId, childId }) =>
      postJSON<{ ok: boolean; gated?: unknown }>(
        `/api/plugins/kanban/links?${boardQuery(slug)}`,
        buildLinkBody(parentId, childId) ?? {},
      ),
    onSuccess: (_result, variables) => invalidateTaskGraph(queryClient, slug, variables.taskId),
  });
}

export function useRemoveKanbanLink(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, AddKanbanLinkInput>({
    mutationFn: ({ parentId, childId }) =>
      deleteJSON<{ ok: boolean }>(
        `/api/plugins/kanban/links?${boardQuery(slug)}&parent_id=${encodeURIComponent(parentId)}&child_id=${encodeURIComponent(childId)}`,
      ),
    onSuccess: (_result, variables) => invalidateTaskGraph(queryClient, slug, variables.taskId),
  });
}

export interface ReassignKanbanTaskInput {
  taskId: string;
  profile: string;
  reclaimFirst?: boolean;
  reason?: string;
}

export function useReassignKanbanTask(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<KanbanReassignResponse, Error, ReassignKanbanTaskInput>({
    mutationFn: ({ taskId, profile, reclaimFirst, reason }) =>
      postJSON<KanbanReassignResponse>(
        `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}/reassign?${boardQuery(slug)}`,
        buildReassignBody({ profile, reclaimFirst, reason }) ?? { profile: null },
      ),
    onSuccess: (_result, variables) => {
      invalidateTaskGraph(queryClient, slug, variables.taskId);
      requestKanbanDispatch(slug);
    },
  });
}

export function useReclaimKanbanTask(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { taskId: string; reason?: string }>({
    mutationFn: ({ taskId, reason }) =>
      postJSON<{ ok: boolean }>(
        `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}/reclaim?${boardQuery(slug)}`,
        { reason: reason ?? null },
      ),
    onSuccess: (_result, variables) => invalidateTaskGraph(queryClient, slug, variables.taskId),
  });
}

export function useDecomposeKanbanTask(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<KanbanDecomposeResponse, Error, { taskId: string }>({
    mutationFn: ({ taskId }) =>
      postJSON<KanbanDecomposeResponse>(
        `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}/decompose?${boardQuery(slug)}`,
        { author: "dashboard" },
      ),
    onSuccess: (_result, variables) => {
      invalidateTaskGraph(queryClient, slug, variables.taskId);
      requestKanbanDispatch(slug);
    },
  });
}

export function useUploadKanbanAttachment(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<KanbanUploadResult, Error, { taskId: string; file: File }>({
    mutationFn: async ({ taskId, file }) => {
      const result = await uploadKanbanAttachment(attachmentUploadPath(taskId, slug), file);
      if (!result.ok) throw new Error(result.error ?? "上传失败");
      return result;
    },
    onSuccess: (_result, variables) => invalidateTaskGraph(queryClient, slug, variables.taskId),
  });
}

export function useDeleteKanbanAttachment(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { taskId: string; attachmentId: number }>({
    mutationFn: ({ attachmentId }) =>
      deleteJSON(`${attachmentDeletePath(attachmentId)}?${boardQuery(slug)}`),
    onSuccess: (_result, variables) => invalidateTaskGraph(queryClient, slug, variables.taskId),
  });
}

export interface CreateKanbanBoardVariables {
  body: Record<string, unknown>;
}

export function useCreateKanbanBoard() {
  const queryClient = useQueryClient();
  return useMutation<{ board?: { slug?: string } | null; current?: string | null }, Error, CreateKanbanBoardVariables>({
    mutationFn: ({ body }) => postJSON("/api/plugins/kanban/boards", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boards });
    },
  });
}

export function useArchiveKanbanBoard() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { slug: string }>({
    mutationFn: ({ slug }) =>
      deleteJSON(`${buildArchiveBoardPath(slug)}?delete=false`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: kanbanKeys.boards });
    },
  });
}
