import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeKernelRetry,
  describeKernelStatus,
  isKernelDegraded,
  isKernelReadyMode,
  kernelErrorPreview,
  kernelModeText,
  kernelRestartDisabledReason,
  retryKernel,
  syncKernelRuntime,
} from "./kernel-status";

describe("describeKernelStatus", () => {
  it("labels an attached kernel with its endpoint", () => {
    const line = describeKernelStatus({
      mode: "attached",
      host: "127.0.0.1",
      port: 60303,
      pid: 10852,
    });
    expect(line.tone).toBe("ok");
    expect(line.label).toBe("内核");
    expect(line.text).toBe("已接管 · 127.0.0.1:60303");
  });

  it("labels a desktop-spawned kernel with its pid", () => {
    const line = describeKernelStatus({
      mode: "spawned",
      host: "127.0.0.1",
      port: 51274,
      pid: 1234,
    });
    expect(line.tone).toBe("ok");
    expect(line.text).toBe("CN 启动 · 127.0.0.1:51274 · pid 1234");
  });

  it("labels a remote backend from its base URL", () => {
    const line = describeKernelStatus({ mode: "remote", baseUrl: "http://192.168.31.7:9119" });
    expect(line.text).toBe("远程 192.168.31.7:9119");
  });

  it("surfaces restart progress and give-up reasons", () => {
    expect(describeKernelStatus({ mode: "restarting", restarts: 2 }).text).toBe("重启中 · 第 2 次");
    const gaveUp = describeKernelStatus({ mode: "gave_up", restarts: 3, lastError: "超时" });
    expect(gaveUp.tone).toBe("err");
    expect(gaveUp.text).toBe("已停止重启 · 超时");
  });

  it("falls back to a waiting line when no status is known", () => {
    expect(describeKernelStatus(null).text).toBe("未接管 · 等待桌面端准备");
    expect(describeKernelStatus({ mode: "failed", lastError: "找不到 hermes" }).text).toBe(
      "启动失败 · 找不到 hermes",
    );
  });

  it("flags a degraded kernel and keeps the boot error recoverable", () => {
    const line = describeKernelStatus({
      mode: "degraded",
      baseUrl: "http://127.0.0.1:9119",
      lastError: "spawn hermes serve 失败：找不到可执行文件",
    });

    expect(line.tone).toBe("warn");
    expect(line.label).toBe("内核");
    expect(line.text).toBe("内核异常 · 已降级 · 127.0.0.1:9119");
    expect(line.title).toBe("spawn hermes serve 失败：找不到可执行文件");
    expect(kernelModeText("degraded")).toBe("内核异常（已降级）");
    expect(kernelRestartDisabledReason({ mode: "degraded" })).toBeNull();
    expect(isKernelDegraded({ mode: "degraded" })).toBe(true);
    expect(isKernelDegraded({ mode: "attached" })).toBe(false);
  });

  it("returns to a normal line once a degraded kernel recovers to attached", () => {
    expect(describeKernelStatus({ mode: "degraded", lastError: "启动失败" }).text).toContain("内核异常");
    const recovered = describeKernelStatus({
      mode: "attached",
      host: "127.0.0.1",
      port: 9119,
      lastError: null,
    });
    expect(recovered.tone).toBe("ok");
    expect(recovered.text).toBe("已接管 · 127.0.0.1:9119");
    expect(recovered.text).not.toContain("内核异常");
  });

  it("collapses and truncates long kernel errors for one-line display", () => {
    expect(kernelErrorPreview("  第一行\n  第二行  ")).toBe("第一行 第二行");
    const long = "x".repeat(300);
    const preview = kernelErrorPreview(long, 40);
    expect(preview).toHaveLength(40);
    expect(preview.endsWith("…")).toBe(true);
    expect(kernelErrorPreview(null)).toBe("");
  });
});

describe("retryKernel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when the desktop bridge is missing", async () => {
    vi.stubGlobal("window", {});
    await expect(retryKernel()).resolves.toBeNull();
  });

  it("clears the degraded flags on the runtime config after a successful retry", async () => {
    const invoke = vi.fn().mockResolvedValue({
      mode: "attached",
      host: "127.0.0.1",
      port: 9119,
      restarts: 0,
      lastError: null,
    });
    vi.stubGlobal("window", {
      hermesDesktop: { retryKernel: invoke },
      __HERMES_RUNTIME__: {
        backendReady: false,
        backendDegraded: true,
        backendDegradedReason: "spawn hermes serve 失败",
      },
    });

    const next = await retryKernel();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(next?.mode).toBe("attached");
    expect(window.__HERMES_RUNTIME__?.backendDegraded).toBe(false);
    expect(window.__HERMES_RUNTIME__?.backendDegradedReason).toBeUndefined();
    expect(window.__HERMES_RUNTIME__?.backendReady).toBe(true);
  });

  it("returns null instead of throwing when the command rejects", async () => {
    vi.stubGlobal("window", {
      hermesDesktop: { retryKernel: vi.fn().mockRejectedValue(new Error("ipc down")) },
    });

    await expect(retryKernel()).resolves.toBeNull();
  });

  it("keeps the kernel degraded and stores the new lastError", async () => {
    vi.stubGlobal("window", {
      hermesDesktop: {
        retryKernel: vi.fn().mockResolvedValue({
          mode: "degraded",
          baseUrl: "http://127.0.0.1:9119",
          lastError: "端口 9119 仍被占用",
        }),
      },
      __HERMES_RUNTIME__: { backendDegraded: true, backendDegradedReason: "旧错误" },
    });

    const next = await retryKernel();

    expect(next?.mode).toBe("degraded");
    expect(isKernelDegraded(next)).toBe(true);
    expect(window.__HERMES_RUNTIME__?.backendDegraded).toBe(true);
    expect(window.__HERMES_RUNTIME__?.backendDegradedReason).toBe("端口 9119 仍被占用");
  });
});

describe("syncKernelRuntime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function installRuntime(runtime: Record<string, unknown>) {
    vi.stubGlobal("window", { __HERMES_RUNTIME__: runtime });
    return window.__HERMES_RUNTIME__!;
  }

  it("adopts a moved base url and asks callers to reconnect once", () => {
    const config = installRuntime({ apiBaseUrl: "http://127.0.0.1:51274", backendDegraded: true });

    const first = syncKernelRuntime({ mode: "spawned", baseUrl: "http://127.0.0.1:60303" });

    expect(first.baseUrlChanged).toBe(true);
    expect(first.previousBaseUrl).toBe("http://127.0.0.1:51274");
    expect(config.apiBaseUrl).toBe("http://127.0.0.1:60303");
    expect(config.dashboardApiBaseUrl).toBe("http://127.0.0.1:60303");
    expect(config.backendDegraded).toBe(false);

    const second = syncKernelRuntime({ mode: "spawned", baseUrl: "http://127.0.0.1:60303" });
    expect(second.baseUrlChanged).toBe(false);
    expect(second.baseUrl).toBe("http://127.0.0.1:60303");
  });

  it("keeps the vite dev proxy untouched but still records the dashboard origin", () => {
    const config = installRuntime({ connectionMode: "local" });

    expect(syncKernelRuntime({ mode: "attached", baseUrl: "http://127.0.0.1:60303" }).baseUrlChanged).toBe(true);
    expect(config.apiBaseUrl).toBeUndefined();
    expect(config.dashboardApiBaseUrl).toBe("http://127.0.0.1:60303");

    expect(syncKernelRuntime({ mode: "attached", baseUrl: "http://127.0.0.1:60303" }).baseUrlChanged).toBe(false);
  });

  it("leaves a degraded kernel's endpoint alone and keeps the reason", () => {
    const config = installRuntime({ apiBaseUrl: "http://127.0.0.1:9119", backendDegraded: false });

    const outcome = syncKernelRuntime({ mode: "degraded", baseUrl: "http://127.0.0.1:60303", lastError: "启动失败" });

    expect(outcome.baseUrlChanged).toBe(false);
    expect(outcome.ready).toBe(false);
    expect(config.apiBaseUrl).toBe("http://127.0.0.1:9119");
    expect(config.backendDegraded).toBe(true);
    expect(config.backendDegradedReason).toBe("启动失败");
  });

  it("does nothing while the kernel is restarting", () => {
    const config = installRuntime({ apiBaseUrl: "http://127.0.0.1:51274", backendDegraded: false });

    const outcome = syncKernelRuntime({ mode: "restarting", restarts: 2, baseUrl: "http://127.0.0.1:51274" });

    expect(outcome.baseUrlChanged).toBe(false);
    expect(config.backendDegraded).toBe(false);
    expect(config.apiBaseUrl).toBe("http://127.0.0.1:51274");
  });
});

describe("describeKernelRetry", () => {
  it("reports a started kernel for every ready mode", () => {
    for (const mode of ["attached", "spawned", "remote"]) {
      expect(isKernelReadyMode(mode)).toBe(true);
      expect(describeKernelRetry({ mode })).toEqual({ ok: true, text: "内核已启动" });
    }
    expect(isKernelReadyMode("degraded")).toBe(false);
  });

  it("surfaces the new lastError while still degraded", () => {
    const outcome = describeKernelRetry({ mode: "degraded", lastError: "找不到 hermes.exe" });
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toBe("内核仍未启动：找不到 hermes.exe");
    expect(describeKernelRetry({ mode: "degraded", lastError: null }).text).toBe("内核仍未启动");
  });
});
