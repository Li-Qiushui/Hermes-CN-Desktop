import { runtime } from "@/lib/runtime";
import type { KanbanAttachmentResponse } from "@/lib/kanban";

export interface KanbanUploadResult {
  ok: boolean;
  response?: KanbanAttachmentResponse | null;
  error?: string | null;
}

function authOnly(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = runtime.getSessionToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Hermes-Session-Token"] = token;
  }
  return headers;
}

export async function uploadKanbanAttachment(
  path: string,
  file: File,
  uploadedBy = "dashboard",
): Promise<KanbanUploadResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("uploaded_by", uploadedBy);
  let response: Response;
  try {
    response = await fetch(runtime.getApiUrl(path), {
      method: "POST",
      body: form,
      headers: authOnly(),
    });
  } catch (error) {
    return {
      ok: false,
      error: `上传请求没有到达内核（内嵌桌面模式不支持多段上传，改用局域网/浏览器打开看板）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, error: `HTTP ${response.status}${body ? `：${body}` : ""}` };
  }
  try {
    return { ok: true, response: (await response.json()) as KanbanAttachmentResponse };
  } catch {
    return { ok: true, response: null };
  }
}
