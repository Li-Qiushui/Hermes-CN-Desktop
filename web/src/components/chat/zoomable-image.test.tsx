// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessageImage } from "./message-image";
import { ZoomableImage } from "./zoomable-image";

const DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

afterEach(() => cleanup());

function renderImage(onRowClick = vi.fn()) {
  render(
    <div onClick={onRowClick}>
      <div role="toolbar" aria-label="消息操作">
        <button type="button" onClick={onRowClick}>
          复制
        </button>
      </div>
      <MessageImage image={{ url: DATA_URL, alt: "截图" }} />
    </div>,
  );
  return { onRowClick, trigger: screen.getByRole("button", { name: "查看大图：截图" }) };
}

function dialog() {
  return screen.queryByRole("dialog");
}

describe("ZoomableImage", () => {
  it("点击图片打开大图遮罩", () => {
    const { trigger } = renderImage();
    expect(dialog()).toBeNull();
    fireEvent.click(trigger);
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute("aria-label")).toBe("查看大图：截图");
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
  });

  it("Esc 关闭遮罩", () => {
    const { trigger } = renderImage();
    fireEvent.click(trigger);
    expect(dialog()).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog()).toBeNull();
  });

  it("关闭后焦点回到原图", () => {
    const { trigger } = renderImage();
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });

  it("点击图片与遮罩都不透传到消息操作条", () => {
    const { onRowClick, trigger } = renderImage();
    fireEvent.click(trigger);
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(dialog()!);
    expect(dialog()).toBeNull();
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "关闭大图" }));
    expect(dialog()).toBeNull();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("滚轮缩放后双击复位", () => {
    const { trigger } = renderImage();
    fireEvent.click(trigger);
    const overlay = dialog()!;
    fireEvent.wheel(overlay, { deltaY: -240, clientX: 100, clientY: 100 });
    const zoomed = screen.getByRole("button", { name: "复位缩放" }).textContent;
    expect(zoomed).not.toBe("100%");
    fireEvent.doubleClick(overlay);
    expect(screen.getByRole("button", { name: "复位缩放" }).textContent).toBe("100%");
    expect(dialog()).not.toBeNull();
  });

  it("放大按钮改变缩放比例", () => {
    const { trigger } = renderImage();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByRole("button", { name: "复位缩放" }).textContent).not.toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "缩小" }));
    expect(screen.getByRole("button", { name: "复位缩放" }).textContent).toBe("100%");
  });

  it("独立使用时不带消息图片框架也能打开大图", () => {
    render(<ZoomableImage src={DATA_URL} alt="图表" />);
    fireEvent.click(screen.getByRole("button", { name: "查看大图：图表" }));
    expect(dialog()).not.toBeNull();
    expect(screen.getByRole("button", { name: "复位缩放" }).textContent).toBe("100%");
  });
});
