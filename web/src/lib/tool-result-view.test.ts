import { describe, expect, it } from "vitest";

import {
  MAX_STRUCTURED_DIFF_LINES,
  buildToolResultView,
  diffTextLines,
  parseUnifiedDiff,
} from "./tool-result-view";

describe("buildToolResultView terminal", () => {
  it("pulls command, output and exit code out of the terminal result envelope", () => {
    const view = buildToolResultView({
      name: "terminal",
      arguments: { command: "pnpm test", workdir: "D:/repo/web" },
      summary: JSON.stringify({ output: "1 failing\n", exit_code: 1, elapsed_seconds: 3.2 }),
    });

    expect(view.kind).toBe("terminal");
    if (view.kind !== "terminal") return;
    expect(view.command).toBe("pnpm test");
    expect(view.workdir).toBe("D:/repo/web");
    expect(view.stdout).toBe("1 failing\n");
    expect(view.exitCode).toBe(1);
  });

  it("keeps an empty but successful run distinguishable from a missing result", () => {
    const view = buildToolResultView({
      name: "terminal",
      arguments: { command: "true" },
      summary: JSON.stringify({ output: "", exit_code: 0 }),
    });

    expect(view.kind).toBe("terminal");
    if (view.kind !== "terminal") return;
    expect(view.exitCode).toBe(0);
    expect(view.stdout).toBe("");
    expect(view.stderr).toBeUndefined();
  });

  it("splits stdout and stderr when the backend returns them separately", () => {
    const view = buildToolResultView({
      name: "bash",
      arguments: { command: "npm run build" },
      summary: JSON.stringify({ stdout: "ok\n", stderr: "warn\n", exit_code: 0 }),
    });

    expect(view.kind).toBe("terminal");
    if (view.kind !== "terminal") return;
    expect(view.stdout).toBe("ok\n");
    expect(view.stderr).toBe("warn\n");
  });

  it("treats a plain-text body as terminal output", () => {
    const view = buildToolResultView({ name: "terminal", arguments: { command: "ls" }, summary: "a.txt" });

    expect(view.kind).toBe("terminal");
    if (view.kind !== "terminal") return;
    expect(view.stdout).toBe("a.txt");
    expect(view.exitCode).toBeUndefined();
  });

  it("surfaces the error envelope message", () => {
    const view = buildToolResultView({
      name: "terminal",
      arguments: { command: "sleep 999" },
      summary: JSON.stringify({ output: "", exit_code: 124, error: "Command timed out" }),
    });

    expect(view.kind).toBe("terminal");
    if (view.kind !== "terminal") return;
    expect(view.exitCode).toBe(124);
    expect(view.errorText).toBe("Command timed out");
  });
});

describe("buildToolResultView file changes", () => {
  it("parses the server-side unified diff from a patch result", () => {
    const view = buildToolResultView({
      name: "patch",
      arguments: { path: "src/a.ts", old_string: "const b = 2;", new_string: "const b = 3;" },
      summary: JSON.stringify({
        success: true,
        diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n",
        files_modified: ["src/a.ts"],
      }),
    });

    expect(view.kind).toBe("file");
    if (view.kind !== "file") return;
    expect(view.files).toHaveLength(1);
    expect(view.files[0].path).toBe("src/a.ts");
    expect(view.added).toBe(2);
    expect(view.removed).toBe(1);
    expect(view.files[0].rows.map((row) => row.type)).toEqual(["ctx", "del", "add", "add"]);
    expect(view.files[0].rows[0]).toMatchObject({ oldLine: 1, newLine: 1 });
    expect(view.files[0].rows[1]).toMatchObject({ oldLine: 2 });
    expect(view.files[0].rows[2]).toMatchObject({ newLine: 2 });
    expect(view.files[0].rows[3]).toMatchObject({ newLine: 3 });
  });

  it("diffs old_string/new_string when the result carries no diff text", () => {
    const view = buildToolResultView({
      name: "patch",
      arguments: { path: "src/b.ts", old_string: "a\nb\nc", new_string: "a\nB\nc" },
      summary: "Patched src/b.ts",
    });

    expect(view.kind).toBe("file");
    if (view.kind !== "file") return;
    expect(view.path).toBe("src/b.ts");
    expect(view.added).toBe(1);
    expect(view.removed).toBe(1);
    expect(view.files[0].rows.filter((row) => row.type === "ctx")).toHaveLength(2);
  });

  it("renders a full write_file call as added lines", () => {
    const view = buildToolResultView({
      name: "write_file",
      arguments: { path: "src/new.ts", content: "line1\nline2\nline3\n" },
      summary: JSON.stringify({ bytes_written: 17, verified: true }),
    });

    expect(view.kind).toBe("file");
    if (view.kind !== "file") return;
    expect(view.added).toBe(3);
    expect(view.removed).toBe(0);
    expect(view.files[0].rows.map((row) => [row.type, row.newLine])).toEqual([
      ["add", 1],
      ["add", 2],
      ["add", 3],
    ]);
  });

  it("keeps an unparseable patch body as fallback text instead of dropping it", () => {
    const view = buildToolResultView({
      name: "patch",
      arguments: { mode: "patch", patch: "*** Begin Patch\n*** Update File: src/c.ts\n@@\n-a\n+b\n*** End Patch" },
      summary: JSON.stringify({ success: true }),
    });

    expect(view.kind).toBe("file");
    if (view.kind !== "file") return;
    expect(view.files).toHaveLength(0);
    expect(view.fallbackText).toContain("*** Begin Patch");
    expect(view.fallbackLabel).toBe("patch");
  });

  it("degrades to side-by-side text past the structured limit", () => {
    const lines = Array.from({ length: MAX_STRUCTURED_DIFF_LINES + 1 }, (_, index) => `line ${index}`);
    const view = buildToolResultView({
      name: "patch",
      arguments: { path: "src/huge.ts", old_string: lines.join("\n"), new_string: `${lines.join("\n")}\ntail` },
      summary: "ok",
    });

    expect(view.kind).toBe("file");
    if (view.kind !== "file") return;
    expect(view.files).toHaveLength(0);
    expect(view.sideBySide?.newText).toContain("tail");
    expect(view.note).toContain("降级");
  });
});

describe("buildToolResultView fallbacks", () => {
  it("keeps the argument JSON for tools it does not recognise", () => {
    const view = buildToolResultView({
      name: "web_search",
      arguments: { query: "hermes agent" },
      summary: "5 results",
    });

    expect(view.kind).toBe("json");
    if (view.kind !== "json") return;
    expect(view.argsText).toContain("hermes agent");
    expect(view.outputText).toBe("5 results");
  });

  it("falls back to raw text when there is nothing structured to show", () => {
    const view = buildToolResultView({ name: "mystery_tool", summary: "plain output" });

    expect(view.kind).toBe("raw");
    if (view.kind !== "raw") return;
    expect(view.outputText).toBe("plain output");
    expect(view.argsText).toBeUndefined();
  });

  it("never throws on escaped or truncated JSON", () => {
    const view = buildToolResultView({
      name: "read_file",
      arguments: { path: "a.ts" },
      summary: '{"output": "unterminated',
    });

    expect(view.kind).toBe("json");
  });
});

describe("diffTextLines", () => {
  it("prunes common prefix and suffix", () => {
    const result = diffTextLines("a\nb\nc\nd", "a\nb\nX\nd");

    expect(result?.added).toBe(1);
    expect(result?.removed).toBe(1);
    expect(result?.rows.map((row) => row.type)).toEqual(["ctx", "ctx", "del", "add", "ctx"]);
    expect(result?.rows[2].oldLine).toBe(3);
    expect(result?.rows[3].newLine).toBe(3);
  });

  it("returns null past the limit", () => {
    const big = Array.from({ length: MAX_STRUCTURED_DIFF_LINES + 1 }, (_, index) => `${index}`);
    expect(diffTextLines(big.join("\n"), "x")).toBeNull();
  });

  it("round-trips an empty file", () => {
    const result = diffTextLines("", "a\nb");
    expect(result?.added).toBe(2);
    expect(result?.removed).toBe(0);
  });
});

describe("parseUnifiedDiff", () => {
  it("handles multiple files and hunk gaps", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/a.ts b/a.ts",
        "index 111..222 100644",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "@@ -5,1 +5,2 @@",
        " keep",
        "+added",
        "diff --git a/b.ts b/b.ts",
        "--- a/b.ts",
        "+++ b/b.ts",
        "@@ -1,1 +0,0 @@",
        "-gone",
      ].join("\n"),
    );

    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("a.ts");
    expect(files[0].rows.some((row) => row.type === "gap")).toBe(true);
    expect(files[0].added).toBe(2);
    expect(files[0].removed).toBe(1);
    expect(files[1].path).toBe("b.ts");
    expect(files[1].removed).toBe(1);
  });

  it("returns nothing for non-diff text", () => {
    expect(parseUnifiedDiff("hello world")).toHaveLength(0);
  });
});

describe("persisted history payloads", () => {
  it("renders a replayed patch result that carries no argument record", () => {
    const content = JSON.stringify({
      success: true,
      diff: "--- a/D:\\\\Project\\\\app\\\\src\\\\a.ts\n+++ b/D:\\\\Project\\\\app\\\\src\\\\a.ts\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n",
    });
    const view = buildToolResultView({ name: "patch", summary: content });

    expect(view.kind).toBe("file");
    if (view.kind !== "file") return;
    expect(view.files[0].path).toContain("a.ts");
    expect(view.added).toBe(1);
    expect(view.removed).toBe(1);
  });

  it("renders a replayed terminal result that only has output", () => {
    const view = buildToolResultView({
      name: "terminal",
      summary: '{"output": "hello\\n"}',
    });

    expect(view.kind).toBe("terminal");
    if (view.kind !== "terminal") return;
    expect(view.stdout).toBe("hello\n");
    expect(view.command).toBeUndefined();
  });
});
