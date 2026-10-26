/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamErrorCard } from "@/stores/chat";
import { StreamErrorCardView } from "./stream-error-card";

afterEach(cleanup);

function card(overrides: Partial<StreamErrorCard> = {}): StreamErrorCard {
  return {
    id: "live-error-card-1",
    title: "响应失败",
    detail: "rate limit exceeded",
    kind: "other",
    createdAt: 1,
    ...overrides,
  };
}

describe("StreamErrorCardView", () => {
  it("详情默认展开，可以收起", () => {
    render(<StreamErrorCardView card={card()} onDismiss={() => {}} />);
    expect(screen.getByText("rate limit exceeded")).toBeTruthy();

    fireEvent.click(screen.getByText("隐藏详情"));
    expect(screen.queryByText("rate limit exceeded")).toBeNull();
  });

  it("卡上不给「重试原请求」，关掉会回调", () => {
    const onDismiss = vi.fn();
    render(<StreamErrorCardView card={card()} onDismiss={onDismiss} />);

    expect(screen.queryByText("重试")).toBeNull();
    expect(screen.queryByText(/重发/)).toBeNull();

    fireEvent.click(screen.getByLabelText("关闭错误提示"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("配置类错误才给「打开设置」", () => {
    const onOpenSettings = vi.fn();
    const { unmount } = render(
      <StreamErrorCardView
        card={card({ kind: "config", title: "模型还没配置好", code: "MODEL_NOT_CONFIGURED" })}
        onDismiss={() => {}}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(screen.getByText("打开设置"));
    expect(onOpenSettings).toHaveBeenCalledWith("/models");
    unmount();

    render(<StreamErrorCardView card={card()} onDismiss={() => {}} onOpenSettings={onOpenSettings} />);
    expect(screen.queryByText("打开设置")).toBeNull();
  });
});
