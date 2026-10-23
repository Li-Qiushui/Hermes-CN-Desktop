import { beforeEach, describe, expect, it } from "vitest";
import { debugBus } from "./debug-bus";
import {
  GatewayRpcError,
  GatewayResultError,
  classifyGatewayError,
  humanizeGatewayError,
  parseGatewayResult,
  unsupportedMethodMessage,
} from "./gateway-result";
import {
  cachedUnsupportedMethod,
  forgetGatewayCapabilities,
  isMethodKnownUnsupported,
  listUnsupportedMethods,
  rememberUnsupportedMethod,
} from "./gateway-capabilities";

const KERNEL_UNSUPPORTED_FULL =
  "unknown method: provider.models — the client and the Hermes backend are out of sync " +
  "(different versions); run 'hermes update' and restart both";
const KERNEL_UNSUPPORTED_DOTTED =
  "unknown method: provider.models. the client and the Hermes backend are out of sync";
const BANNED_FRAGMENTS = ["hermes update", "out of sync", "unknown method", "method not found"];

function expectNoEnglishLeak(text: string): void {
  const lower = text.toLowerCase();
  for (const fragment of BANNED_FRAGMENTS) {
    expect(lower).not.toContain(fragment);
  }
}

const passSchema = { parse: (v: unknown) => v as { ok: boolean } };

function zodErrorDouble(): Error {
  const err = Object.assign(new Error('[{"path":["session_id"],"message":"Required"}]'), {
    issues: [{ path: ["session_id"], message: "Required" }],
  });
  err.name = "ZodError";
  return err;
}

// A schema double that throws a ZodError-shaped error, like the real
// `SessionResumeResult.parse` does when `session_id` is missing (#58).
const failSchema = {
  parse: (_v: unknown): { session_id: string } => {
    throw zodErrorDouble();
  },
};

describe("parseGatewayResult", () => {
  beforeEach(() => debugBus.clear());

  it("returns the parsed value on success", () => {
    expect(parseGatewayResult(passSchema, { ok: true }, "session.create")).toEqual({
      ok: true,
    });
  });

  it("throws a friendly GatewayResultError instead of the raw ZodError blob", () => {
    let thrown: unknown;
    try {
      parseGatewayResult(failSchema, { accepted: true, async: true }, "session.resume");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GatewayResultError);
    const err = thrown as GatewayResultError;
    expect(err.method).toBe("session.resume");
    expect(err.message).toContain("session.resume");
    // The infamous raw Zod blob must not reach the user.
    expect(err.message).not.toContain("session_id");
    expect(err.message).not.toContain("Required");
  });

  it("records a redacted gateway debug entry on parse failure", () => {
    expect(() =>
      parseGatewayResult(failSchema, { accepted: true, async: true }, "session.resume"),
    ).toThrow(GatewayResultError);
    const entries = debugBus.snapshot();
    const last = entries[entries.length - 1];
    expect(last?.type).toBe("gateway");
    expect(last?.level).toBe("error");
    expect(last?.summary).toContain("session.resume");
  });
});

describe("humanizeGatewayError", () => {
  it("passes through an already-friendly GatewayResultError message", () => {
    expect(humanizeGatewayError(new GatewayResultError("自定义友好消息", "session.create"))).toBe(
      "自定义友好消息",
    );
  });

  it("converts a raw ZodError into a friendly message without leaking fields", () => {
    const msg = humanizeGatewayError(zodErrorDouble());
    expect(msg).not.toContain("session_id");
    expect(msg).toContain("无法识别");
  });

  it("localizes timeout errors", () => {
    const message = humanizeGatewayError(new Error("RPC timeout: session.resume"));
    expect(message).toContain("超时");
    expect(message).toContain("LM Studio");
    // The dev-facing jargon (64K context, OOM, 显存) is intentionally dropped.
    expect(message).not.toContain("OOM");
  });

  it("localizes connection-closed errors", () => {
    expect(humanizeGatewayError(new Error("WebSocket closed"))).toContain("连接已断开");
    expect(humanizeGatewayError(new Error("WebSocket connection lost"))).toContain("连接已断开");
  });

  it("converts an unsupported-method frame into Chinese fallback copy", () => {
    const message = humanizeGatewayError(new Error(KERNEL_UNSUPPORTED_FULL));
    expect(message).toContain("当前内核不支持该功能");
    expect(message).toContain("provider.models");
    expectNoEnglishLeak(message);
  });

  it("keeps other meaningful backend error messages unchanged", () => {
    expect(humanizeGatewayError(new Error("session not found"))).toBe("session not found");
  });
});

describe("classifyGatewayError", () => {
  const unsupportedCases = [
    ["full kernel text with em dash", KERNEL_UNSUPPORTED_FULL, "provider.models"],
    ["dotted variant", KERNEL_UNSUPPORTED_DOTTED, "provider.models"],
    ["bare method name", "unknown method: provider.models", "provider.models"],
    ["no dash and no method", "unknown method", undefined],
    ["method not found with jsonrpc code", "Method not found (-32601)", undefined],
    ["not implemented", "not implemented: session.rewind", "session.rewind"],
    ["out of sync wording only", "the client and the Hermes backend are out of sync", undefined],
  ] as const;

  for (const [label, text, method] of unsupportedCases) {
    it(`classifies ${label} as unsupported-method`, () => {
      const info = classifyGatewayError(new Error(text));
      expect(info.kind).toBe("unsupported-method");
      expect(info.retryable).toBe(false);
      expect(info.method).toBe(method);
      expect(info.message).toContain("当前内核不支持该功能");
      expectNoEnglishLeak(info.message);
      if (method) expect(info.message).toContain(method);
    });
  }

  it("prefers method and code carried by GatewayRpcError over the text", () => {
    const info = classifyGatewayError(
      new GatewayRpcError("unknown method: whatever", { method: "provider.models", code: -32601 }),
    );
    expect(info.kind).toBe("unsupported-method");
    expect(info.method).toBe("provider.models");
    expect(info.code).toBe(-32601);
  });

  it("recognizes its own Chinese fallback text as unsupported (idempotent)", () => {
    const first = classifyGatewayError(new Error(KERNEL_UNSUPPORTED_FULL));
    const again = classifyGatewayError(new Error(first.message));
    expect(again.kind).toBe("unsupported-method");
    expect(again.method).toBe("provider.models");
    expect(again.message).toBe(first.message);
  });

  it("does not swallow unrelated categories into unsupported-method", () => {
    expect(classifyGatewayError(new Error("RPC timeout: session.resume")).kind).toBe("timeout");
    expect(classifyGatewayError(new Error("WebSocket closed")).kind).toBe("network");
    expect(classifyGatewayError(new Error("401 unauthorized")).kind).toBe("auth");
    expect(classifyGatewayError(new Error("404 not found")).kind).toBe("not-found");
    expect(classifyGatewayError(new Error("internal error")).kind).toBe("server");
    expect(classifyGatewayError(new Error("boom")).kind).toBe("unknown");
  });

  it("builds friendly copy with and without a method name", () => {
    expect(unsupportedMethodMessage("provider.models")).toBe(
      "当前内核不支持该功能（provider.models），已降级处理",
    );
    expect(unsupportedMethodMessage()).toBe("当前内核不支持该功能，已降级处理");
    expectNoEnglishLeak(unsupportedMethodMessage("provider.models"));
  });
});

describe("gateway capability cache", () => {
  beforeEach(() => forgetGatewayCapabilities());

  it("remembers a method after the first unsupported failure", () => {
    const info = classifyGatewayError(new Error(KERNEL_UNSUPPORTED_FULL));
    expect(cachedUnsupportedMethod("provider.models")).toBeNull();

    rememberUnsupportedMethod(info);

    const cached = cachedUnsupportedMethod("provider.models");
    expect(cached).not.toBeNull();
    expect(cached?.message).toBe(info.message);
    expect(cached?.kind).toBe("unsupported-method");
    expect(isMethodKnownUnsupported("provider.models")).toBe(true);
    expect(isMethodKnownUnsupported("session.rewind")).toBe(false);
    expect(listUnsupportedMethods()).toEqual(["provider.models"]);
  });

  it("returns the identical structured error on a cache hit", () => {
    const info = classifyGatewayError(new Error(KERNEL_UNSUPPORTED_FULL));
    rememberUnsupportedMethod(info);
    expect(cachedUnsupportedMethod("provider.models")).toEqual(info);
  });

  it("ignores other kinds and unnamed methods", () => {
    rememberUnsupportedMethod(classifyGatewayError(new Error("RPC timeout: session.resume")));
    rememberUnsupportedMethod(classifyGatewayError(new Error("unknown method")));
    expect(listUnsupportedMethods()).toEqual([]);
  });

  it("clears on forgetGatewayCapabilities (reconnect / kernel swap)", () => {
    rememberUnsupportedMethod(classifyGatewayError(new Error(KERNEL_UNSUPPORTED_FULL)));
    forgetGatewayCapabilities();
    expect(cachedUnsupportedMethod("provider.models")).toBeNull();
    expect(listUnsupportedMethods()).toEqual([]);
  });

  it("treats undefined method as a miss", () => {
    expect(cachedUnsupportedMethod(undefined)).toBeNull();
  });
});
