/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "./chat-types";
import {
  ErrorRecoveryActions,
  errorLogPath,
  resolveErrorDisplayText,
} from "./error-recovery-actions";
import { MessageTimeline } from "./message-timeline";

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  vi.restoreAllMocks();
});

const stubScrollTo = () => {
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = vi.fn();
};

const userAsk: ChatMessage = {
  id: "stored-10",
  role: "user",
  createdAt: 10,
  status: "complete",
  text: "跑一下测试",
};

describe("resolveErrorDisplayText", () => {
  it("swaps an unsupported-method payload for the Chinese fallback", () => {
    const shown = resolveErrorDisplayText("unknown method: prompt.submit");
    expect(shown).toBe("当前内核不支持该功能（prompt.submit），已降级处理");
    expect(shown).not.toContain("unknown method");
  });

  it("keeps the original wording for other classes", () => {
    expect(resolveErrorDisplayText("与内核的连接已断开")).toBe("与内核的连接已断开");
  });
});

describe("errorLogPath", () => {
  it("picks the log file out of an error message", () => {
    expect(errorLogPath("写入失败，详见 D:/hermes/logs/kernel.log")).toBe("D:/hermes/logs/kernel.log");
    expect(errorLogPath("see /home/u/.hermes/logs/session.jsonl for details")).toBe(
      "/home/u/.hermes/logs/session.jsonl",
    );
  });

  it("reports nothing when the message carries no path", () => {
    expect(errorLogPath("请求超时，请重试。")).toBeNull();
  });
});

describe("ErrorRecoveryActions", () => {
  it("retries through the caller's existing retry path", () => {
    const onRetry = vi.fn();
    render(
      <ErrorRecoveryActions
        text="与内核的连接已断开"
        retrySource={userAsk}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByText("重试"));
    expect(onRetry).toHaveBeenCalledWith(userAsk);
  });

  it("hides retry for auth failures and points at the API key instead", () => {
    const onOpenSettings = vi.fn();
    render(
      <ErrorRecoveryActions
        text="401 unauthorized"
        retrySource={userAsk}
        onRetry={() => {}}
        onOpenSettings={onOpenSettings}
      />,
    );
    expect(screen.queryByText("重试")).toBeNull();
    fireEvent.click(screen.getByText("检查 API Key"));
    expect(onOpenSettings).toHaveBeenCalledWith("/models");
  });

  it("routes network failures to the connection settings", () => {
    const onOpenSettings = vi.fn();
    render(<ErrorRecoveryActions text="failed to fetch" onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByText("检查连接"));
    expect(onOpenSettings).toHaveBeenCalledWith("/connection");
  });

  it("copies the raw error detail", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ErrorRecoveryActions text="请求超时，请重试。" />);
    fireEvent.click(screen.getByText("复制错误详情"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("请求超时，请重试。"));
    expect(await screen.findByText("已复制")).toBeTruthy();
  });

  it("offers the log only when the message carries a path", () => {
    const { rerender } = render(<ErrorRecoveryActions text="内核服务出错" />);
    expect(screen.queryByText("打开日志")).toBeNull();
    rerender(<ErrorRecoveryActions text="内核服务出错，日志：D:/hermes/logs/kernel.log" />);
    expect(screen.getByText("打开日志")).toBeTruthy();
  });
});

describe("system error notice in the timeline", () => {
  it("renders recovery actions next to the failed turn", () => {
    stubScrollTo();
    const errorNotice: ChatMessage = {
      id: "stored-11",
      role: "system",
      createdAt: 11,
      status: "complete",
      error: true,
      text: "请求超时，请重试。",
    };
    const onRetry = vi.fn();
    render(
      <MemoryRouter>
        <MessageTimeline messages={[userAsk, errorNotice]} onRetryMessage={onRetry} />
      </MemoryRouter>,
    );
    expect(screen.getByText("请求失败")).toBeTruthy();
    fireEvent.click(screen.getByText("重试"));
    expect(onRetry).toHaveBeenCalledWith(userAsk);
  });
});
