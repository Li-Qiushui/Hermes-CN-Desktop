import { beforeEach, describe, expect, it } from "vitest";

import {
  clearDisclosureChoices,
  disclosureKey,
  forgetDisclosureChoice,
  readDisclosureChoice,
  rememberDisclosureChoice,
  resolveDisclosureOpen,
} from "./activity-disclosure";

beforeEach(() => {
  clearDisclosureChoices();
});

describe("disclosure choices", () => {
  it("keys are stable per kind and node id", () => {
    expect(disclosureKey("thinking", "m-1", 0)).toBe("thinking|m-1|0");
    expect(disclosureKey("activity", "t-1")).toBe("activity|t-1");
    expect(disclosureKey("thinking", "m-1", 0)).toBe(disclosureKey("thinking", "m-1", 0));
  });

  it("falls back to the automatic policy when the user never touched the row", () => {
    expect(resolveDisclosureOpen("thinking|m-1|0", true)).toBe(true);
    expect(resolveDisclosureOpen("tool|t-1", false)).toBe(false);
  });

  it("keeps an explicit user choice ahead of every automatic policy", () => {
    rememberDisclosureChoice("thinking|m-1|0", false);
    expect(resolveDisclosureOpen("thinking|m-1|0", true)).toBe(false);

    rememberDisclosureChoice("activity|t-1", true);
    expect(resolveDisclosureOpen("activity|t-1", false)).toBe(true);
    expect(readDisclosureChoice("activity|t-1")).toBe(true);
  });

  it("ignores an undefined key instead of writing a shared bucket", () => {
    rememberDisclosureChoice(undefined, true);
    expect(readDisclosureChoice(undefined)).toBeUndefined();
    expect(resolveDisclosureOpen(undefined, false)).toBe(false);
  });

  it("can forget a single choice without dropping the others", () => {
    rememberDisclosureChoice("tool|t-1", true);
    rememberDisclosureChoice("tool|t-2", true);
    forgetDisclosureChoice("tool|t-1");
    expect(readDisclosureChoice("tool|t-1")).toBeUndefined();
    expect(readDisclosureChoice("tool|t-2")).toBe(true);
  });
});
