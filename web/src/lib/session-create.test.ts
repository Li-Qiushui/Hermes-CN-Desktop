import { describe, expect, it } from "vitest";
import { sessionCreateParams } from "./session-create";

/**
 * Mirror of the backend's effort resolution contract (Hermes-CN-Core), kept
 * tiny and explicit so this test documents the cross-boundary behavior:
 *
 *  - `session.create` reads the top-level `reasoning_effort` param
 *    (tui_gateway/methods_session.py:57) and parses it with
 *    hermes_constants.parse_reasoning_effort.
 *  - The fork/aux Codex path reads `extra_body.reasoning.effort` with the
 *    fallback `effort = reasoning_cfg.get("effort") or "medium"`
 *    (agent/auxiliary_client.py:1513).
 *  - A top-level `thinking-effort` / `thinking_effort` key is never read.
 */
function backendResolveEffort(payload: Record<string, unknown>): string {
  const direct = payload.reasoning_effort;
  if (typeof direct === "string" && direct) return direct;
  const reasoning = payload.reasoning;
  if (reasoning && typeof reasoning === "object") {
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort === "string" && effort) return effort;
  }
  return "medium";
}

describe("session.create payload carries the composer's thinking-effort", () => {
  it("ships reasoning_effort on session.create when the composer is set to max", () => {
    const payload = sessionCreateParams("/work", "max");
    // The exact key the backend reads — without it the request resolves to
    // the backend default (medium), which is the reported bug.
    expect(payload.reasoning_effort).toBe("max");
    expect(backendResolveEffort(payload)).toBe("max");
  });

  it("never ships a bogus thinking-effort key the backend does not read", () => {
    const payload = sessionCreateParams("/work", "max");
    // Before the fix the CN Desktop omitted the effort entirely (or shipped
    // it under a key the backend ignores), so the backend's
    // `reasoning_cfg.get("effort") or "medium"` fallback always returned
    // medium — "max" in the UI, medium on the wire.
    expect("thinking-effort" in payload).toBe(false);
    expect("thinking_effort" in payload).toBe(false);
    expect(backendResolveEffort(payload)).toBe("max");
  });

  it("omits reasoning_effort when the composer is unset so the backend default applies", () => {
    const payload = sessionCreateParams("/work", null);
    expect("reasoning_effort" in payload).toBe(false);
    expect(backendResolveEffort(payload)).toBe("medium");
  });

  it("always marks the session as a desktop session", () => {
    // 内核按 source 决定 surface：缺省 tui 会丢掉 desktop_ui / catalog 工具集。
    expect(sessionCreateParams("/work").source).toBe("desktop");
    expect(sessionCreateParams(undefined, null).source).toBe("desktop");
  });

  it("preserves the previous createSession shape when only cwd is provided", () => {
    expect(sessionCreateParams("/work")).toEqual({ source: "desktop", cwd: "/work" });
    expect(sessionCreateParams("  /work  ")).toEqual({ source: "desktop", cwd: "/work" });
    expect(sessionCreateParams(undefined, "max")).toEqual({ source: "desktop", reasoning_effort: "max" });
    expect(sessionCreateParams(undefined)).toEqual({ source: "desktop" });
  });
});
