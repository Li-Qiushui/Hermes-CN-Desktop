import { fetchJSON } from "./transport";

/**
 * 本地文件读取：为 `MEDIA:` 与 `::preview{file="…"}` 两条渲染通道提供统一入口。
 *
 * 两条路都只走已有的、带鉴权的通道，不申请 file:// 权限、不加 Tauri fs 能力：
 *  - 桌面桥存在（window.hermesDesktop.readFileText / readFileDataUrl）时先用它，
 *    本机路径不必绕一圈 HTTP；
 *  - 否则打 Core 的 `/api/fs/read-text` / `/api/fs/read-data-url`（后者对任意扩展
 *    名返回 `data:<mime>;base64,…`，同样带大小上限）。
 */

export interface LocalTextFile {
  binary: boolean;
  byteSize: number;
  language?: string;
  mimeType?: string;
  path: string;
  text: string;
  truncated: boolean;
}

function bridge() {
  return typeof window === "undefined" ? undefined : window.hermesDesktop;
}

function isMissingResult(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { ok?: unknown }).ok === false;
}

/** 读文本（HTML 预览、源码降级共用）。失败直接抛，调用方决定降级成什么。 */
export async function readLocalTextFile(path: string): Promise<LocalTextFile> {
  const readText = bridge()?.readFileText;
  if (readText) {
    try {
      const result = await readText(path);
      if (result && !isMissingResult(result) && typeof (result as LocalTextFile).text === "string") {
        return result as LocalTextFile;
      }
    } catch {
      // 本机读不到就退回 Core（文件可能只在 Core 那台机器上）。
    }
  }

  return fetchJSON<LocalTextFile>(`/api/fs/read-text?path=${encodeURIComponent(path)}`);
}

/** 读任意类型文件为 data URL（图片/音频/视频共用）。 */
export async function readLocalDataUrl(path: string): Promise<string> {
  const readDataUrl = bridge()?.readFileDataUrl;
  if (readDataUrl) {
    try {
      const direct = await readDataUrl(path);
      if (typeof direct === "string" && direct.startsWith("data:")) return direct;
    } catch {
      // 同上，交给 Core。
    }
  }

  const result = await fetchJSON<{ dataUrl?: unknown; data_url?: unknown }>(
    `/api/fs/read-data-url?path=${encodeURIComponent(path)}`,
  );
  const dataUrl =
    typeof result.dataUrl === "string" ? result.dataUrl
      : typeof result.data_url === "string" ? result.data_url
      : "";
  if (!dataUrl.startsWith("data:")) {
    throw new Error("文件内容为空或不是可预览的类型");
  }
  return dataUrl;
}
