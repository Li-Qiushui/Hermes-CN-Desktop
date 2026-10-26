import { describe, expect, it } from "vitest";
import { hasAutoContinuePayload } from "./use-gateway";

describe("hasAutoContinuePayload", () => {
  it("resume 排上自动续跑时返回 true", () => {
    expect(
      hasAutoContinuePayload({
        session_id: "rt-1",
        running: false,
        auto_continue: { attempt: 1, interrupted_at: 1_769_000_000.5 },
      }),
    ).toBe(true);
  });

  it("没有该字段或字段为 null 时返回 false", () => {
    expect(hasAutoContinuePayload({ session_id: "rt-1", running: true })).toBe(false);
    expect(hasAutoContinuePayload({ session_id: "rt-1", auto_continue: null })).toBe(false);
    expect(hasAutoContinuePayload(null)).toBe(false);
  });
});
