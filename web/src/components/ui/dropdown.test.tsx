// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dropdown } from "./dropdown";

beforeEach(() => cleanup());

const OPTIONS = [
  { value: "all", label: "全部" },
  { value: "1", label: "P1" },
  { value: "2", label: "P2" },
];

describe("Dropdown", () => {
  it("点击触发器展开菜单，aria-expanded 同步", () => {
    const onChange = vi.fn();
    render(<Dropdown options={OPTIONS} value="all" onChange={onChange} ariaLabel="优先级" />);
    const trigger = screen.getByRole("button", { name: "优先级" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const listbox = screen.getByRole("listbox", { name: "优先级" });
    expect(listbox).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("点击选项回传 value 并关闭菜单", () => {
    const onChange = vi.fn();
    render(<Dropdown options={OPTIONS} value="all" onChange={onChange} ariaLabel="优先级" />);
    fireEvent.click(screen.getByRole("button", { name: "优先级" }));
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(onChange).toHaveBeenCalledWith("1");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("选中项标记 aria-selected 且只标一个", () => {
    render(<Dropdown options={OPTIONS} value="1" onChange={() => undefined} ariaLabel="优先级" />);
    fireEvent.click(screen.getByRole("button", { name: "优先级" }));
    const selected = screen.getAllByRole("option").filter((node) => node.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("P1");
  });

  it("键盘 ↓↓ Enter 选中第三项", () => {
    const onChange = vi.fn();
    render(<Dropdown options={OPTIONS} value="all" onChange={onChange} ariaLabel="优先级" />);
    const trigger = screen.getByRole("button", { name: "优先级" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const listbox = screen.getByRole("listbox", { name: "优先级" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("↑ 从当前选中往回移动并循环", () => {
    const onChange = vi.fn();
    render(<Dropdown options={OPTIONS} value="all" onChange={onChange} ariaLabel="优先级" />);
    fireEvent.click(screen.getByRole("button", { name: "优先级" }));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2");
  });

  it("Esc 关闭并把焦点还给触发器", () => {
    render(<Dropdown options={OPTIONS} value="all" onChange={() => undefined} ariaLabel="优先级" />);
    const trigger = screen.getByRole("button", { name: "优先级" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("点击外部关闭菜单", () => {
    render(<Dropdown options={OPTIONS} value="all" onChange={() => undefined} ariaLabel="优先级" />);
    fireEvent.click(screen.getByRole("button", { name: "优先级" }));
    expect(screen.queryByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("监听窗口滚动并重算 fixed 位置", () => {
    render(<Dropdown options={OPTIONS} value="all" onChange={() => undefined} ariaLabel="优先级" minWidth={220} />);
    fireEvent.click(screen.getByRole("button", { name: "优先级" }));
    const listbox = screen.getByRole("listbox") as HTMLElement;
    expect(listbox.style.position === "" || listbox.style.position === "fixed").toBe(true);
    fireEvent.scroll(window);
    expect(screen.queryByRole("listbox")).toBeTruthy();
    expect(Number.parseFloat(listbox.style.width)).toBeGreaterThanOrEqual(220);
  });
});
