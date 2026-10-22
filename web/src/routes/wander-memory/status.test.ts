import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/wander-memory";
import {
  serverStatusPresentation,
  wanderStatusErrorText,
} from "./status";

describe("Wander Memory server status presentation", () => {
  it("distinguishes client mode from actual server connectivity", () => {
    expect(serverStatusPresentation({
      mode: "live",
      loading: true,
      hasData: false,
      hasError: false,
    })).toEqual({ label: "检查中", tone: "neutral" });
    expect(serverStatusPresentation({
      mode: "live",
      loading: false,
      hasData: false,
      hasError: true,
    })).toEqual({ label: "离线", tone: "danger" });
    expect(serverStatusPresentation({
      mode: "live",
      loading: false,
      hasData: true,
      hasError: false,
    })).toEqual({ label: "在线", tone: "success" });
    expect(serverStatusPresentation({
      mode: "demo",
      loading: false,
      hasData: true,
      hasError: false,
    })).toEqual({ label: "演示", tone: "warning" });
  });

  it("turns network failures into actionable offline copy", () => {
    expect(wanderStatusErrorText(new ApiError(
      "network_failure",
      "no response from server",
      null,
    ))).toBe("离线 — 请启动 MemOS，或在下方更新端点设置");
  });
});
