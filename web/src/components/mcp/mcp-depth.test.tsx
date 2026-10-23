// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { McpServerWire, McpTestWire } from "@/lib/mcp-wire";

const { useMcpLogs } = vi.hoisted(() => ({
  useMcpLogs: vi.fn(() => ({
    lines: [] as string[],
    loading: false,
    error: null as string | null,
    updatedAt: 1,
  })),
}));

vi.mock("@/hooks/use-mcp", () => ({ useMcpLogs }));

import { McpServerDetail } from "./mcp-server-detail";
import { McpRawEditor } from "./mcp-raw-editor";
import { McpToolList } from "./mcp-tool-list";
import { readToolFilter } from "@/lib/mcp-tools";

afterEach(() => {
  cleanup();
  useMcpLogs.mockClear();
});

const server: McpServerWire = {
  name: "filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "server-filesystem"],
  env: {},
  enabled: true,
  auth: null,
  tools: { exclude: ["write_file"] },
};

const result: McpTestWire = {
  ok: true,
  tools: [
    { name: "read_file", description: "读取文件", schema_chars: 400 },
    { name: "write_file", description: "写入文件", schema_chars: 800 },
  ],
};

function renderDetail(overrides: Partial<Parameters<typeof McpServerDetail>[0]> = {}) {
  const onToggleTool = vi.fn();
  const onSaveRaw = vi.fn();
  render(
    <McpServerDetail
      server={server}
      result={result}
      testing={false}
      savingTools={false}
      rawServers={{ filesystem: { command: "npx", args: ["-y", "server-filesystem"] } }}
      savingRaw={false}
      onTest={vi.fn()}
      onToggleTool={onToggleTool}
      onSaveRaw={onSaveRaw}
      {...overrides}
    />,
  );
  return { onToggleTool, onSaveRaw };
}

describe("McpToolList", () => {
  it("renders one switch per tool with the enabled state from the filter", () => {
    render(
      <McpToolList tools={result.tools} filter={readToolFilter(server.tools)} busy={false} onToggle={vi.fn()} />,
    );
    expect(screen.getByRole("switch", { name: "禁用工具 read_file" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "启用工具 write_file" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("工具 1 / 2 启用")).toBeTruthy();
  });

  it("emits the toggled tool name and target state", () => {
    const onToggle = vi.fn();
    render(
      <McpToolList tools={result.tools} filter={readToolFilter(server.tools)} busy={false} onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "禁用工具 read_file" }));
    expect(onToggle).toHaveBeenCalledWith("read_file", false);
    fireEvent.click(screen.getByRole("switch", { name: "启用工具 write_file" }));
    expect(onToggle).toHaveBeenCalledWith("write_file", true);
  });

  it("disables every row while a save is in flight", () => {
    render(
      <McpToolList tools={result.tools} filter={readToolFilter(undefined)} busy onToggle={vi.fn()} />,
    );
    for (const button of screen.getAllByRole("switch")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("locks rows and explains the whitelist case", () => {
    render(
      <McpToolList
        tools={result.tools}
        filter={readToolFilter({ include: ["read_file"] })}
        busy={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText(/tools.include 白名单/)).toBeTruthy();
    expect((screen.getByRole("switch", { name: /read_file/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the per-tool estimated cost", () => {
    render(
      <McpToolList tools={result.tools} filter={readToolFilter(undefined)} busy={false} onToggle={vi.fn()} />,
    );
    expect(screen.getByText("~100")).toBeTruthy();
    expect(screen.getByText("~200")).toBeTruthy();
  });
});

describe("McpServerDetail", () => {
  it("opens on the tool tab and reports the context cost", () => {
    renderDetail();
    expect(screen.getByText("工具 1 / 2 启用")).toBeTruthy();
    expect(screen.getByText("2 个工具 · 约 300 tokens 上下文占用")).toBeTruthy();
  });

  it("asks for a probe before listing tools", () => {
    const onTest = vi.fn();
    renderDetail({ result: undefined, onTest });
    expect(screen.getByText(/先测试连接才能列出/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "测试连接并列出工具" }));
    expect(onTest).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed probe instead of an empty list", () => {
    renderDetail({ result: { ok: false, error: "connection refused", tools: [] } });
    expect(screen.getByText("connection refused")).toBeTruthy();
  });

  it("switches to the log tab and mounts both sources", () => {
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(screen.getByRole("button", { name: "stdio 子进程" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Agent 侧" })).toBeTruthy();
    expect(useMcpLogs).toHaveBeenCalledWith(
      expect.objectContaining({ source: "stdio", serverName: "filesystem", paused: false }),
    );
  });

  it("pauses the log follow and filters what is on screen", () => {
    useMcpLogs.mockReturnValue({
      lines: ["INFO filesystem: connect", "ERROR filesystem: boom"],
      loading: false,
      error: null,
      updatedAt: 1,
    });
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(screen.getByText("INFO filesystem: connect")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /暂停跟随/ }));
    expect(useMcpLogs).toHaveBeenLastCalledWith(expect.objectContaining({ paused: true }));
    fireEvent.change(screen.getByLabelText("搜索日志"), { target: { value: "error" } });
    expect(screen.queryByText("INFO filesystem: connect")).toBeNull();
  });

  it("opens the raw tab with the whole mcp_servers map", () => {
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "原始 JSON" }));
    expect((screen.getByLabelText("mcpServers JSON") as HTMLTextAreaElement).value).toContain("filesystem");
  });
});

describe("McpRawEditor", () => {
  it("blocks the save and shows a line number while the JSON is broken", () => {
    const onSave = vi.fn();
    render(<McpRawEditor servers={{}} saving={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("mcpServers JSON"), {
      target: { value: '{\n  "fs": {\n    "command": "npx"\n  ,\n}' },
    });
    expect(screen.getByText(/^第 \d+ 行/)).toBeTruthy();
    expect(screen.getByText("JSON 有误")).toBeTruthy();
    const save = screen.getByRole("button", { name: "保存 JSON" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves the parsed map once the JSON is valid", () => {
    const onSave = vi.fn();
    render(<McpRawEditor servers={{}} saving={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("mcpServers JSON"), {
      target: { value: '{"fs": {"command": "npx", "args": ["-y", "x"]}}' },
    });
    expect(screen.getByText("1 个服务 · JSON 校验通过")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存 JSON" }));
    expect(onSave).toHaveBeenCalledWith({ fs: { command: "npx", args: ["-y", "x"] } });
  });

  it("flags a schema problem even when the JSON parses", () => {
    render(<McpRawEditor servers={{}} saving={false} onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("mcpServers JSON"), {
      target: { value: '{"fs": {"args": []}}' },
    });
    expect(screen.getByText(/缺少 url 或 command/)).toBeTruthy();
  });
});
