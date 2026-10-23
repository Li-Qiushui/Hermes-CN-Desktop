// @vitest-environment jsdom
import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  ComposerErrorMessage,
  GooseComposer,
  isComposerComposing,
  pathsFromDroppedText,
} from "./goose-composer";
import { GatewayRpcError } from "@/lib/gateway-result";

function renderComposer(element: ReactElement): string {
  return ReactDOMServer.renderToStaticMarkup(
    <MemoryRouter>
      {element}
    </MemoryRouter>,
  );
}

describe("ComposerErrorMessage", () => {
  it("shows a voice setup action for missing STT provider errors", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ComposerErrorMessage
        message="语音识别尚未配置可用提供方。请到“语音”设置选择本地识别。"
        onConfigureVoice={() => {}}
      />,
    );

    expect(html).toContain("语音识别尚未配置可用提供方");
    expect(html).toContain("去配置语音");
  });

  it("does not show a voice setup action for generic composer errors", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ComposerErrorMessage message="发送失败" onConfigureVoice={() => {}} />,
    );

    expect(html).toContain("发送失败");
    expect(html).not.toContain("去配置语音");
  });
});

describe("GooseComposer IME guard", () => {
  it("keeps keydown handlers suspended until the delayed composition state resets", () => {
    expect(isComposerComposing({ tracked: true, native: false })).toBe(true);
    expect(isComposerComposing({ tracked: false, native: true })).toBe(true);
    expect(isComposerComposing({ tracked: false, native: false })).toBe(false);
  });
});

describe("GooseComposer slash hints", () => {
  it("renders new-task slash hints without the compress command", () => {
    const html = renderComposer(
      <GooseComposer
        hints={[
          { kbd: "/skill", label: "选择 Skill" },
          { kbd: "/", label: "输入指令" },
          { label: "把文件拖入此处直接附加" },
        ]}
        showCompressCommand={false}
      />,
    );

    expect(html).toContain("/skill");
    expect(html).toContain("选择 Skill");
    expect(html).toContain("输入指令");
    expect(html).toContain("把文件拖入此处直接附加");
    expect(html).not.toContain("/compress");
  });

  it("renders session slash hints with the compress command", () => {
    const html = renderComposer(
      <GooseComposer
        hints={[
          { kbd: "/skill", label: "选择 Skill" },
          { kbd: "/", label: "输入指令" },
          { kbd: "/compress", label: "触发会话压缩" },
        ]}
      />,
    );

    expect(html).toContain("/skill");
    expect(html).toContain("输入指令");
    expect(html).toContain("/compress");
    expect(html).toContain("触发会话压缩");
  });
});

describe("GooseComposer workspace picker", () => {
  it("renders initial draft text in the textarea", () => {
    const html = renderComposer(<GooseComposer initial="恢复的草稿" />);

    expect(html).toContain("恢复的草稿");
  });

  it("renders a clear workspace action when a workspace is selected", () => {
    const html = renderComposer(
      <GooseComposer initialWorkspacePath="/Users/enzo/Project" />,
    );

    expect(html).toContain("Project");
    expect(html).toContain("不指定默认工作区：/Users/enzo/Project");
  });

  it("does not render the clear workspace action without a selected workspace", () => {
    const html = renderComposer(<GooseComposer />);

    expect(html).not.toContain("不指定默认工作区：");
  });
});

const STEER_LABEL = "引导（运行中，并入当前轮；Alt 点击改为排队）";
const QUEUE_SEND_LABEL = "发送（运行中，将加入队列）";

function liveComposer(element: ReactElement) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

function messageInput(): HTMLTextAreaElement {
  return screen.getByLabelText("输入消息") as HTMLTextAreaElement;
}

function steerSendButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: STEER_LABEL }) as HTMLButtonElement;
}

function queueSendButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: QUEUE_SEND_LABEL }) as HTMLButtonElement;
}

describe("GooseComposer while the agent is running", () => {
  afterEach(() => cleanup());

  it("keeps the textarea editable and steers non-empty text via onSteer", async () => {
    const onSend = vi.fn();
    const onSteer = vi.fn().mockResolvedValue({ status: "queued" });
    liveComposer(
      <GooseComposer
        loading
        onSteer={onSteer}
        onStop={vi.fn()}
        onSend={onSend}
        submitShortcut="enter"
      />,
    );

    const textarea = messageInput();
    expect(textarea.disabled).toBe(false);

    fireEvent.change(textarea, { target: { value: "顺便看下日志" } });
    const sendButton = steerSendButton();
    expect(sendButton.disabled).toBe(false);

    fireEvent.click(sendButton);
    await waitFor(() => expect(onSteer).toHaveBeenCalledWith("顺便看下日志"));
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(messageInput().value).toBe(""));
    expect(screen.getByText("已并入当前轮")).toBeTruthy();
  });

  it("treats a redirected reply as delivered and clears the input", async () => {
    const onSteer = vi.fn().mockResolvedValue({ status: "redirected" });
    liveComposer(<GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={vi.fn()} />);

    fireEvent.change(messageInput(), { target: { value: "改成只跑测试" } });
    fireEvent.click(steerSendButton());

    await waitFor(() => expect(screen.getByText("已改为当前轮的新指令")).toBeTruthy());
    await waitFor(() => expect(messageInput().value).toBe(""));
  });

  it("keeps the draft and warns when the kernel rejects the steer", async () => {
    const onSteer = vi.fn().mockResolvedValue({ status: "rejected" });
    liveComposer(<GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={vi.fn()} />);

    fireEvent.change(messageInput(), { target: { value: "补一句" } });
    fireEvent.click(steerSendButton());

    await waitFor(() => expect(screen.getByText(/内容仍留在输入框/)).toBeTruthy());
    expect(messageInput().value).toBe("补一句");
  });

  it("degrades to the queue when the agent does not support steer", async () => {
    const onSend = vi.fn();
    const onSteer = vi
      .fn()
      .mockRejectedValue(
        new GatewayRpcError("agent does not support steer", { method: "session.steer", code: 4010 }),
      );
    liveComposer(
      <GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={onSend} />,
    );

    fireEvent.change(messageInput(), { target: { value: "排队这条" } });
    fireEvent.click(steerSendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toMatchObject({ text: "排队这条" });
    expect(screen.getByText("当前内核不支持实时引导，已改为排队")).toBeTruthy();
    // 降级后按钮永久回到入队态，不再每轮重试 session.steer。
    await waitFor(() => expect(queueSendButton().getAttribute("title")).toBe(QUEUE_SEND_LABEL));
    expect(screen.queryByRole("button", { name: STEER_LABEL })).toBeNull();
  });

  it("degrades to the queue on unsupported-method too", async () => {
    const onSend = vi.fn();
    const onSteer = vi
      .fn()
      .mockRejectedValue(
        new GatewayRpcError("unknown method: session.steer", { method: "session.steer", code: -32601 }),
      );
    liveComposer(<GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={onSend} />);

    fireEvent.change(messageInput(), { target: { value: "老内核" } });
    fireEvent.click(steerSendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(screen.getByText("当前内核不支持实时引导，已改为排队")).toBeTruthy();
  });

  it("queues when the steer is fired with Alt held", async () => {
    const onSend = vi.fn();
    const onSteer = vi.fn().mockResolvedValue({ status: "queued" });
    liveComposer(<GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={onSend} />);

    fireEvent.change(messageInput(), { target: { value: "排到下一轮" } });
    fireEvent.click(steerSendButton(), { altKey: true });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toMatchObject({ text: "排到下一轮" });
    expect(onSteer).not.toHaveBeenCalled();
  });

  it("renders stop and send side by side, and stop still fires onStop", () => {
    const onStop = vi.fn();
    liveComposer(<GooseComposer loading onStop={onStop} onSend={vi.fn()} />);

    const stopButton = screen.getByRole("button", { name: "中止响应" });
    expect(stopButton.getAttribute("title")).toBe("中止响应");
    expect(steerSendButton().getAttribute("title")).toBe(
      "引导（不打断当前轮，并入这一轮；Alt 点击改为排队）",
    );

    fireEvent.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("refuses to submit an empty message while running", () => {
    const onSend = vi.fn();
    const onSteer = vi.fn();
    liveComposer(<GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={onSend} />);

    const sendButton = steerSendButton();
    expect(sendButton.disabled).toBe(true);

    fireEvent.click(sendButton);
    expect(onSteer).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("blocks whitespace-only text locally instead of calling the kernel", () => {
    const onSteer = vi.fn();
    liveComposer(<GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={vi.fn()} />);

    fireEvent.change(messageInput(), { target: { value: "   " } });
    expect(steerSendButton().disabled).toBe(true);
    fireEvent.click(steerSendButton());
    expect(onSteer).not.toHaveBeenCalled();
  });

  it("steers on Enter but leaves Shift+Enter for a newline", async () => {
    const onSteer = vi.fn().mockResolvedValue({ status: "queued" });
    liveComposer(
      <GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={vi.fn()} submitShortcut="enter" />,
    );

    const textarea = messageInput();
    fireEvent.change(textarea, { target: { value: "引导一条" } });

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    await Promise.resolve();
    expect(onSteer).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSteer).toHaveBeenCalledWith("引导一条"));
  });

  it("blocks built-in slash commands instead of steering them", async () => {
    const onSend = vi.fn();
    const onSteer = vi.fn();
    liveComposer(
      <GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={onSend} submitShortcut="enter" />,
    );

    const textarea = messageInput();
    fireEvent.change(textarea, { target: { value: "/compress" } });

    expect(steerSendButton().disabled).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter" });
    await Promise.resolve();

    expect(onSend).not.toHaveBeenCalled();
    expect(onSteer).not.toHaveBeenCalled();
    expect(screen.getAllByText(/需等当前回合结束再执行/)).toHaveLength(2);
  });

  it("shows the steer hint only when there is content to submit", () => {
    liveComposer(<GooseComposer loading onStop={vi.fn()} onSend={vi.fn()} />);

    expect(screen.queryByText(/发送会并入当前轮/)).toBeNull();

    fireEvent.change(messageInput(), { target: { value: "补充一句" } });
    expect(screen.getByText(/发送会并入当前轮/)).toBeTruthy();
    expect(screen.getByText(/Alt 点击改为排队/)).toBeTruthy();
  });

  it("shows the parked queue count when the parent already queued prompts", () => {
    liveComposer(
      <GooseComposer loading queuedCount={2} onStop={vi.fn()} onSend={vi.fn()} />,
    );

    expect(screen.getByText(/已排队 2 条/)).toBeTruthy();
  });

  it("keeps the single send button when loading has no stop handle", () => {
    liveComposer(<GooseComposer loading onSend={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "中止响应" })).toBeNull();
    expect(screen.queryByRole("button", { name: STEER_LABEL })).toBeNull();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeTruthy();
  });

  it("keeps the send button locked when queueing is opted out", () => {
    liveComposer(
      <GooseComposer
        loading
        queueWhileLoading={false}
        onStop={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    fireEvent.change(messageInput(), { target: { value: "不该发出去" } });

    expect(screen.getByRole("button", { name: "中止响应" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: STEER_LABEL })).toBeNull();
    expect(screen.queryByRole("button", { name: QUEUE_SEND_LABEL })).toBeNull();
    expect(screen.queryByRole("button", { name: "发送消息" })).toBeNull();
  });
});

type NativeDropPayload = { phase: string; paths: string[] };
type NativeDropHandler = (payload: NativeDropPayload) => void;

function mountNativeDropComposer(element: ReactElement): () => NativeDropHandler {
  let handler: NativeDropHandler | null = null;
  window.hermesDesktop = {
    windowType: "tauri",
    request: vi.fn(),
    onFileDrop: (next: NativeDropHandler) => {
      handler = next;
      return () => {
        handler = null;
      };
    },
  } as unknown as Window["hermesDesktop"];
  liveComposer(element);
  return () => {
    if (!handler) throw new Error("native drop handler was not registered");
    return handler;
  };
}

function selectProbeParagraph(text: string) {
  const probe = document.createElement("p");
  probe.textContent = text;
  document.body.appendChild(probe);
  const range = document.createRange();
  range.selectNodeContents(probe);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("dragstart", { bubbles: true }));
}

describe("GooseComposer dropped text", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete window.hermesDesktop;
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  });

  it("only treats absolute path lists as droppable paths", () => {
    expect(pathsFromDroppedText("C:/Temp/a.png")).toEqual(["C:/Temp/a.png"]);
    expect(pathsFromDroppedText("C:/Temp/a.png\nC:/Temp/b.png")).toEqual([
      "C:/Temp/a.png",
      "C:/Temp/b.png",
    ]);
    expect(pathsFromDroppedText("一段被选中的说明文字")).toEqual([]);
    expect(pathsFromDroppedText("C:/Temp/a.png\n这不是路径")).toEqual([]);
    expect(pathsFromDroppedText("https://example.com/a.png")).toEqual([]);
  });

  it("inserts the dragged selection at the caret instead of reporting an error", async () => {
    const dropped = mountNativeDropComposer(<GooseComposer />);
    const textarea = messageInput();
    fireEvent.change(textarea, { target: { value: "AB" } });
    textarea.setSelectionRange(1, 1);

    selectProbeParagraph("选中的一句话");
    window.getSelection()?.removeAllRanges();

    await act(async () => {
      dropped()({ phase: "drop", paths: [] });
    });

    await waitFor(() => expect(messageInput().value).toBe("A选中的一句话B"));
    expect(screen.queryByText(/未能读取拖拽文件路径/)).toBeNull();
  });

  it("keeps attaching files dropped from the desktop", async () => {
    const dropped = mountNativeDropComposer(<GooseComposer />);

    await act(async () => {
      dropped()({ phase: "drop", paths: ["C:/Temp/a.png"] });
    });

    expect(screen.getByText("a.png")).toBeTruthy();
    expect(screen.queryByText(/未能读取拖拽文件路径/)).toBeNull();
  });

  it("inserts the selection on dragend when the native drop never arrives", async () => {
    liveComposer(<GooseComposer />);
    const textarea = messageInput();
    fireEvent.change(textarea, { target: { value: "AB" } });
    textarea.setSelectionRange(1, 1);

    const box = textarea.closest("[data-flush-bottom]") as HTMLElement;
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 200,
      width: 400,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    selectProbeParagraph("拖进来的文本");
    window.getSelection()?.removeAllRanges();

    fireEvent(document, new MouseEvent("dragend", { clientX: 120, clientY: 150, bubbles: true }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
    });

    await waitFor(() => expect(messageInput().value).toBe("A拖进来的文本B"));
  });

  it("inserts multi-line HTML5 text drops and keeps path drops as attachments", async () => {
    liveComposer(<GooseComposer />);
    const textarea = messageInput();
    const box = textarea.closest("[data-flush-bottom]") as HTMLElement;
    expect(box).toBeTruthy();

    fireEvent.drop(box, {
      dataTransfer: {
        files: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? "第一行\n第二行" : ""),
      },
    });

    await waitFor(() => expect(messageInput().value).toBe("第一行\n第二行"));

    fireEvent.drop(box, {
      dataTransfer: {
        files: [],
        types: ["text/uri-list"],
        getData: (type: string) => (type === "text/uri-list" ? "C:/Temp/b.png" : ""),
      },
    });

    await waitFor(() => expect(screen.getByText("b.png")).toBeTruthy());
    expect(messageInput().value).toBe("第一行\n第二行");
  });
});

function pasteIntoComposer(target: HTMLTextAreaElement, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
      files: [],
      items: [],
      types: ["text/plain"],
    },
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("GooseComposer large paste", () => {
  afterEach(() => cleanup());

  it("turns a paste above 3000 characters into a text attachment chip", async () => {
    liveComposer(<GooseComposer />);
    const textarea = messageInput();

    const event = pasteIntoComposer(textarea, "日志行".repeat(8000));

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(document.querySelector("[data-kind=\"file\"]")).toBeTruthy());
    expect(screen.getByText(/^pasted-content-\d{6}-[0-9a-f]+\.txt$/)).toBeTruthy();
    expect(screen.getByText("已粘入的 2.4 万字已转为附件")).toBeTruthy();
    expect(messageInput().value).toBe("");
  });

  it("removes the selection before attaching the pasted text", async () => {
    liveComposer(<GooseComposer />);
    const textarea = messageInput();
    fireEvent.change(textarea, { target: { value: "A删掉B" } });
    textarea.setSelectionRange(1, 3);

    pasteIntoComposer(textarea, "x".repeat(3200));

    await waitFor(() => expect(screen.getByText(/^pasted-content-/)).toBeTruthy());
    expect(messageInput().value).toBe("AB");
  });

  it("leaves short pastes on the native inline path", () => {
    liveComposer(<GooseComposer />);
    const textarea = messageInput();

    const event = pasteIntoComposer(textarea, "短文本");

    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector("[data-kind=\"file\"]")).toBeNull();
    expect(screen.queryByText(/已转为附件/)).toBeNull();
  });
});
