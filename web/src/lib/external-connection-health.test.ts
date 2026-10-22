import { describe, expect, it } from "vitest";
import {
  externalConnectionFailureSummary,
  summarizeExternalConnectionHealth,
} from "./external-connection-health";

describe("summarizeExternalConnectionHealth", () => {
  it("reports a healthy kernel only when HTTP and WebSocket both pass", () => {
    expect(
      summarizeExternalConnectionHealth({
        ok: true,
        baseUrl: "http://127.0.0.1:9119",
        httpOk: true,
        wsOk: true,
        authRequired: false,
        version: "0.18.2",
      }),
    ).toEqual({
      ok: true,
      title: "内核 · 连接正常",
      detail: "Hermes 0.18.2 · HTTP 与实时网关均可用",
    });
  });

  it("uses an explicit gateway failure title when the target is unreachable", () => {
    const summary = summarizeExternalConnectionHealth({
      ok: false,
      baseUrl: "http://127.0.0.1:9119",
      httpOk: false,
      wsOk: false,
      authRequired: false,
      error: "无法连接目标地址: operation timed out",
    });

    expect(summary.title).toBe("内核 · 网关未启动或连接失败");
    expect(summary.detail).toContain("operation timed out");
  });

  it("keeps the gateway warning when HTTP works but the WebSocket handshake fails", () => {
    const summary = summarizeExternalConnectionHealth({
      ok: false,
      baseUrl: "http://127.0.0.1:9119",
      httpOk: true,
      httpStatus: 200,
      wsOk: false,
      authRequired: false,
    });

    expect(summary.title).toBe("内核 · 网关未启动或连接失败");
    expect(summary.detail).toContain("Dashboard 可以访问");
    expect(summary.detail).toContain("实时网关连接失败");
  });

  it("turns invoke failures into the same visible warning", () => {
    expect(externalConnectionFailureSummary(new Error("IPC timeout"))).toEqual({
      ok: false,
      title: "内核 · 网关未启动或连接失败",
      detail: "IPC timeout",
    });
  });

  it("follows the caller's connection label", () => {
    expect(
      summarizeExternalConnectionHealth(
        { ok: true, baseUrl: "https://remote.example.com", httpOk: true, wsOk: true, authRequired: false },
        "远程 Hermes",
      ).title,
    ).toBe("远程 Hermes · 连接正常");
    expect(externalConnectionFailureSummary(new Error("boom"), "本机内核").title).toBe(
      "本机内核 · 网关未启动或连接失败",
    );
  });
});
