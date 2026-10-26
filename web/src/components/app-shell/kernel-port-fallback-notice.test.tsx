// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelStatusView } from "@/lib/kernel-status";

const pendingProbe = () => new Promise<boolean>(() => {});
const reachableProbe = async () => true;
const unreachableProbe = async () => false;

const fallbackStatus: KernelStatusView = {
  mode: "spawned",
  baseUrl: "http://127.0.0.1:60303",
  host: "127.0.0.1",
  port: 60303,
  restarts: 1,
  portFallback: true,
};

beforeEach(() => {
  vi.resetModules();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("KernelPortFallbackNotice", () => {
  it("端口回退态渲染提示条，文案说明已自动重连并给出地址", async () => {
    const { KernelPortFallbackNotice } = await import("./kernel-port-fallback-notice");
    render(<KernelPortFallbackNotice status={fallbackStatus} checkEndpoint={pendingProbe} />);

    const notice = screen.getByTestId("kernel-port-fallback-notice");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("内核换了端口，已自动重连");
    expect(notice.textContent).toContain("自动消失");
    expect(notice.textContent).not.toContain("消息收发会一直连不上");
    expect(notice.textContent).not.toContain("需要重启桌面端");
    expect(notice.textContent).toContain("127.0.0.1:60303");
    expect(screen.getByTestId("kernel-port-fallback-retry")).not.toBeNull();
    expect(screen.getByTestId("kernel-port-fallback-copy")).not.toBeNull();
    expect(screen.getByTestId("kernel-port-fallback-dismiss")).not.toBeNull();
  });

  it("连上新端口后横幅自动消失", async () => {
    const { KernelPortFallbackNotice } = await import("./kernel-port-fallback-notice");
    const { container } = render(
      <KernelPortFallbackNotice status={fallbackStatus} checkEndpoint={reachableProbe} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-testid="kernel-port-fallback-notice"]')).toBeNull(),
    );
  });

  it("连不上新端口时才提示重启桌面端", async () => {
    const { KernelPortFallbackNotice } = await import("./kernel-port-fallback-notice");
    render(<KernelPortFallbackNotice status={fallbackStatus} checkEndpoint={unreachableProbe} />);
    await waitFor(() =>
      expect(screen.getByTestId("kernel-port-fallback-notice").textContent).toContain(
        "内核换了端口，还没连上",
      ),
    );
    expect(screen.getByTestId("kernel-port-fallback-notice").textContent).toContain(
      "重启桌面端",
    );
  });

  it("端点探活打 /api/health，非 2xx 或抛错都算连不上", async () => {
    const { kernelEndpointAnswers } = await import("./kernel-port-fallback-notice");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(kernelEndpointAnswers("http://127.0.0.1:60303/")).resolves.toBe(true);
    await expect(kernelEndpointAnswers("http://127.0.0.1:60303")).resolves.toBe(false);
    await expect(kernelEndpointAnswers("http://127.0.0.1:60303")).resolves.toBe(false);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:60303/api/health");
  });

  it("没有回退标记时不渲染", async () => {
    const { KernelPortFallbackNotice } = await import("./kernel-port-fallback-notice");
    const { container } = render(
      <KernelPortFallbackNotice status={{ ...fallbackStatus, portFallback: false }} />,
    );
    expect(container.firstChild).toBeNull();

    const { container: missing } = render(
      <KernelPortFallbackNotice status={{ mode: "attached", baseUrl: "http://127.0.0.1:9119" }} />,
    );
    expect(missing.firstChild).toBeNull();
  });

  it("本次会话关掉后刷新（模块重开）仍是关闭态，清掉 sessionStorage 后重新出现", async () => {
    const first = await import("./kernel-port-fallback-notice");
    const { container, unmount } = render(<first.KernelPortFallbackNotice status={fallbackStatus} checkEndpoint={pendingProbe} />);
    expect(container.querySelector('[data-testid="kernel-port-fallback-notice"]')).not.toBeNull();

    fireEvent.click(screen.getByTestId("kernel-port-fallback-dismiss"));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="kernel-port-fallback-notice"]')).toBeNull(),
    );
    expect(window.sessionStorage.getItem("hermes.kernelPortFallback.dismissed")).toBe(
      fallbackStatus.baseUrl,
    );
    unmount();

    vi.resetModules();
    const reloaded = await import("./kernel-port-fallback-notice");
    const refreshed = render(<reloaded.KernelPortFallbackNotice status={fallbackStatus} checkEndpoint={pendingProbe} />);
    expect(refreshed.container.querySelector('[data-testid="kernel-port-fallback-notice"]')).toBeNull();
    refreshed.unmount();

    window.sessionStorage.clear();
    vi.resetModules();
    const reopened = await import("./kernel-port-fallback-notice");
    render(<reopened.KernelPortFallbackNotice status={fallbackStatus} checkEndpoint={pendingProbe} />);
    expect(screen.getByTestId("kernel-port-fallback-notice")).not.toBeNull();
  });

  it("storage 不可用时不抛错，仍渲染提示条且关闭仅当前实例生效", async () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: blocked,
    });
    try {
      const { KernelPortFallbackNotice } = await import("./kernel-port-fallback-notice");
      const { container } = render(<KernelPortFallbackNotice status={fallbackStatus} checkEndpoint={pendingProbe} />);
      expect(container.querySelector('[data-testid="kernel-port-fallback-notice"]')).not.toBeNull();

      fireEvent.click(screen.getByTestId("kernel-port-fallback-dismiss"));
      await waitFor(() =>
        expect(container.querySelector('[data-testid="kernel-port-fallback-notice"]')).toBeNull(),
      );
    } finally {
      if (original) Object.defineProperty(window, "sessionStorage", original);
      else delete (window as unknown as { sessionStorage?: Storage }).sessionStorage;
    }
  });

  it("portFallback 转 false 时清掉已存的关闭标记", async () => {
    window.sessionStorage.setItem("hermes.kernelPortFallback.dismissed", "http://127.0.0.1:60303");
    const { KernelPortFallbackNotice } = await import("./kernel-port-fallback-notice");
    const { rerender } = render(<KernelPortFallbackNotice status={fallbackStatus} checkEndpoint={pendingProbe} />);
    rerender(<KernelPortFallbackNotice status={{ ...fallbackStatus, portFallback: false }} />);
    await waitFor(() =>
      expect(window.sessionStorage.getItem("hermes.kernelPortFallback.dismissed")).toBeNull(),
    );
  });
});
