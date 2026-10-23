// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));

import {
  SUBAGENT_ORIGIN_KEY,
  SubagentDialog,
  SubagentOriginBar,
  type SubagentDialogTarget,
} from "./subagent-dialog";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  navigateMock.mockReset();
});

const NOW = 100_000;

function target(overrides: Partial<SubagentDialogTarget> = {}): SubagentDialogTarget {
  return {
    childSessionId: "child-9",
    durationSeconds: undefined,
    goal: "审计 host-hub 接口",
    id: "sub-1",
    lines: ['Grep("鉴权中间件")'],
    model: "deepseek-v4.1-flash",
    startedAt: NOW - 12_500,
    status: "running",
    toolCount: 7,
    ...overrides,
  };
}

describe("子代理运行情况弹窗", () => {
  it("展示目标、模型、四态状态、耗时与工具调用数", () => {
    render(<SubagentDialog target={target()} now={NOW} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-status")).toBe("running");
    expect(screen.getByText("审计 host-hub 接口")).toBeTruthy();
    expect(screen.getByText("deepseek-v4.1-flash")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("已运行 12.5s")).toBeTruthy();
    expect(screen.getByText("7 次工具调用")).toBeTruthy();
    expect(screen.getByText(/Grep\("鉴权中间件"\)/)).toBeTruthy();
  });

  it("Esc 关闭", () => {
    const onClose = vi.fn();
    render(<SubagentDialog target={target()} now={NOW} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点遮罩关闭，点弹窗本体不关", () => {
    const onClose = vi.fn();
    render(<SubagentDialog target={target()} now={NOW} onClose={onClose} />);

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("没有子会话 id 时「在页面中打开」禁用", () => {
    const onOpenInPage = vi.fn();
    render(
      <SubagentDialog target={target({ childSessionId: undefined })} now={NOW} onClose={vi.fn()} onOpenInPage={onOpenInPage} />,
    );

    const jump = screen.getByRole("button", { name: "在页面中打开" }) as HTMLButtonElement;
    expect(jump.disabled).toBe(true);
    fireEvent.click(jump);
    expect(onOpenInPage).not.toHaveBeenCalled();
  });

  it("有子会话 id 时点「在页面中打开」把 id 交出去", () => {
    const onOpenInPage = vi.fn();
    render(<SubagentDialog target={target()} now={NOW} onClose={vi.fn()} onOpenInPage={onOpenInPage} />);

    fireEvent.click(screen.getByRole("button", { name: "在页面中打开" }));
    expect(onOpenInPage).toHaveBeenCalledWith("child-9");
  });

  it("暂停跟随：按钮在暂停/继续之间切换", () => {
    render(<SubagentDialog target={target()} now={NOW} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "暂停跟随" }));
    expect(screen.getByRole("button", { name: "继续跟随" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续跟随" }));
    expect(screen.getByRole("button", { name: "暂停跟随" })).toBeTruthy();
  });
});

describe("子会话返回条", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("在子会话页显示父会话标题，点击回父会话", () => {
    window.sessionStorage.setItem(
      SUBAGENT_ORIGIN_KEY,
      JSON.stringify({ childSessionId: "child-9", parentSessionId: "parent-1", parentTitle: "重构 host-hub 鉴权" }),
    );

    render(<SubagentOriginBar currentSessionId="child-9" />);
    const button = screen.getByRole("button", { name: /返回父会话/ });
    expect(button.textContent).toContain("重构 host-hub 鉴权");

    fireEvent.click(button);
    expect(navigateMock).toHaveBeenCalledWith("/tasks/parent-1");
  });

  it("不在记录的会话里就不显示", () => {
    window.sessionStorage.setItem(
      SUBAGENT_ORIGIN_KEY,
      JSON.stringify({ childSessionId: "child-9", parentSessionId: "parent-1" }),
    );

    render(<SubagentOriginBar currentSessionId="other-session" />);
    expect(screen.queryByRole("button", { name: /返回父会话/ })).toBeNull();
  });

  it("没有来源记录时什么都不渲染", () => {
    const { container } = render(<SubagentOriginBar currentSessionId="child-9" />);
    expect(container.querySelector("[data-subagent-origin-bar]")).toBeNull();
  });
});
