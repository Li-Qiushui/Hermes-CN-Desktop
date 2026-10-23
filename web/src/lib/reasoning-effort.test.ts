import { describe, expect, it } from "vitest";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_SHORT_LABELS,
  buildReasoningEffortUpdate,
  isReasoningEffort,
  normalizeReasoningEffort,
  reasoningEffortFromConfig,
  reasoningEffortSettingOptions,
} from "./reasoning-effort";

describe("reasoning-effort", () => {
  it("exposes the backend's effort set (none + VALID_REASONING_EFFORTS)", () => {
    expect(REASONING_EFFORTS).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("has a label for every effort", () => {
    for (const effort of REASONING_EFFORTS) {
      expect(REASONING_EFFORT_LABELS[effort]).toBeTruthy();
      expect(REASONING_EFFORT_SHORT_LABELS[effort]).toBeTruthy();
    }
  });

  it("defaults to the backend fallback effort", () => {
    expect(DEFAULT_REASONING_EFFORT).toBe("medium");
    expect(isReasoningEffort(DEFAULT_REASONING_EFFORT)).toBe(true);
  });

  describe("isReasoningEffort", () => {
    it("accepts valid values and rejects everything else", () => {
      expect(isReasoningEffort("high")).toBe(true);
      expect(isReasoningEffort("none")).toBe(true);
      expect(isReasoningEffort("HIGH")).toBe(false); // exact match only
      expect(isReasoningEffort("ultra")).toBe(false);
      expect(isReasoningEffort(2)).toBe(false);
      expect(isReasoningEffort(null)).toBe(false);
    });
  });

  describe("normalizeReasoningEffort", () => {
    it("trims and lowercases known values", () => {
      expect(normalizeReasoningEffort("  High ")).toBe("high");
      expect(normalizeReasoningEffort("XHIGH")).toBe("xhigh");
      expect(normalizeReasoningEffort("MAX")).toBe("max");
      expect(normalizeReasoningEffort("  Max ")).toBe("max");
      expect(normalizeReasoningEffort("none")).toBe("none");
    });

    it("returns null for empty / unknown / non-string", () => {
      expect(normalizeReasoningEffort("")).toBeNull();
      expect(normalizeReasoningEffort("   ")).toBeNull();
      expect(normalizeReasoningEffort("turbo")).toBeNull();
      expect(normalizeReasoningEffort(undefined)).toBeNull();
      expect(normalizeReasoningEffort(123)).toBeNull();
    });
  });

  describe("reasoningEffortFromConfig", () => {
    it("reads agent.reasoning_effort from a config object", () => {
      expect(reasoningEffortFromConfig({ agent: { reasoning_effort: "low" } })).toBe("low");
      expect(reasoningEffortFromConfig({ agent: { reasoning_effort: "MEDIUM" } })).toBe("medium");
    });

    it("returns null when the field is missing, empty, or malformed", () => {
      expect(reasoningEffortFromConfig(undefined)).toBeNull();
      expect(reasoningEffortFromConfig(null)).toBeNull();
      expect(reasoningEffortFromConfig({})).toBeNull();
      expect(reasoningEffortFromConfig({ agent: {} })).toBeNull();
      expect(reasoningEffortFromConfig({ agent: { reasoning_effort: "" } })).toBeNull();
      expect(reasoningEffortFromConfig({ agent: "nope" })).toBeNull();
    });
  });

  describe("设置页选项与写入", () => {
    it("exposes the five settings rows with none rendered as 关闭", () => {
      const options = reasoningEffortSettingOptions(null);
      expect(options.map((option) => option.value)).toEqual([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
      ]);
      expect(options.map((option) => option.label)).toEqual(["关闭", "最小", "低", "中", "高"]);
      expect(options[0].label).toBe("关闭");
    });

    it("keeps a high-tier current value selectable so the row is never blank", () => {
      expect(reasoningEffortSettingOptions("xhigh").map((option) => option.value)).toEqual([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(reasoningEffortSettingOptions("high")).toHaveLength(5);
    });

    it("writes agent.reasoning_effort without disturbing other keys", () => {
      const config = {
        agent: { max_turns: 160, service_tier: "fast", reasoning_effort: "low" },
        model: { default: "deepseek-v4-flash" },
      };
      expect(buildReasoningEffortUpdate(config, "none")).toEqual({
        agent: { max_turns: 160, service_tier: "fast", reasoning_effort: "none" },
        model: { default: "deepseek-v4-flash" },
      });
      expect(config.agent.reasoning_effort).toBe("low");
      expect(buildReasoningEffortUpdate({}, "high")).toEqual({
        agent: { reasoning_effort: "high" },
      });
      expect(buildReasoningEffortUpdate({ agent: "nope" }, "high")).toEqual({
        agent: { reasoning_effort: "high" },
      });
    });
  });
});
