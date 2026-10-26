// @vitest-environment jsdom
import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  ComposerErrorMessage,
  GooseComposer,
  formatAttachmentBytes,
  isComposerComposing,
  oversizedAttachmentNotice,
  pathsFromDroppedText,
  writeDraftAttachments,
} from "./goose-composer";
import { MAX_ATTACHMENT_BYTES } from "./goose-composer-attachments";
import { forgetComposerHistory } from "@/lib/composer-drafts";
import { GatewayRpcError } from "@/lib/gateway-result";

function renderComposer(element: ReactElement): string {
  return ReactDOMServer.renderToStaticMarkup(
    <MemoryRouter>
      {element}
    </MemoryRouter>,
  );
}

describe("ComposerErrorMessage", () => {
  it("renders the error text without extra actions", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ComposerErrorMessage message="发送失败" />,
    );

    expect(html).toContain("发送失败");
    expect(html).not.toContain("<button");
  });
});

describe("GooseComposer mention chips", () => {
  afterEach(() => cleanup());

  it("lists committed @ references above the input and removes one", () => {
    liveComposer(<GooseComposer initial="@file:src/a.ts 看下这个文件" />);

    expect(screen.getByLabelText("已引用")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除引用 @file:src/a.ts" }));
    expect(messageInput().value).toBe("看下这个文件");
  });

  it("still hands the raw @ syntax to the kernel on send", async () => {
    const onSend = vi.fn();
    liveComposer(<GooseComposer initial="@file:src/a.ts 看下这个文件" onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0]?.[0]?.text).toBe("@file:src/a.ts 看下这个文件");
  });
});

describe("GooseComposer voice input removal", () => {
  afterEach(() => cleanup());

  it("renders no recording control in the toolbar", () => {
    liveComposer(<GooseComposer />);

    expect(screen.queryAllByRole("button", { name: /语音|录音|转写/ })).toHaveLength(0);
    expect(screen.getByLabelText("输入消息")).toBeTruthy();
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

const STEER_LABEL = "立即引导";
const QUEUE_SEND_LABEL = "发送（运行中，将加入队列）";

function liveComposer(element: ReactElement) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

function messageInput(): HTMLTextAreaElement {
  return screen.getByLabelText("输入消息") as HTMLTextAreaElement;
}

function steerButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: STEER_LABEL }) as HTMLButtonElement;
}

function queueSendButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: QUEUE_SEND_LABEL }) as HTMLButtonElement;
}

describe("GooseComposer while the agent is running", () => {
  afterEach(() => cleanup());

  it("keeps the textarea editable and queues on plain submit", async () => {
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

    fireEvent.change(textarea, { target: { value: "下一轮再看日志" } });
    const sendButton = queueSendButton();
    expect(sendButton.disabled).toBe(false);

    fireEvent.click(sendButton);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toMatchObject({ text: "下一轮再看日志" });
    expect(onSteer).not.toHaveBeenCalled();
    await waitFor(() => expect(messageInput().value).toBe(""));
  });

  it("steers the live turn from the explicit 立即引导 button", async () => {
    const onSend = vi.fn();
    const onSteer = vi.fn().mockResolvedValue({ status: "queued" });
    liveComposer(
      <GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={onSend} />,
    );

    fireEvent.change(messageInput(), { target: { value: "顺便看下日志" } });
    const steer = steerButton();
    expect(steer.disabled).toBe(false);

    fireEvent.click(steer);
    await waitFor(() => expect(onSteer).toHaveBeenCalledWith("顺便看下日志"));
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(messageInput().value).toBe(""));
    expect(screen.getByText("已并入当前轮")).toBeTruthy();
  });

  it("treats a redirected reply as delivered and clears the input", async () => {
    const onSteer = vi.fn().mockResolvedValue({ status: "redirected" });
    liveComposer(<GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={vi.fn()} />);

    fireEvent.change(messageInput(), { target: { value: "改成只跑测试" } });
    fireEvent.click(steerButton());

    await waitFor(() => expect(screen.getByText("已改为当前轮的新指令")).toBeTruthy());
    await waitFor(() => expect(messageInput().value).toBe(""));
  });

  it("keeps the draft and warns when the kernel rejects the steer", async () => {
    const onSteer = vi.fn().mockResolvedValue({ status: "rejected" });
    liveComposer(<GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={vi.fn()} />);

    fireEvent.change(messageInput(), { target: { value: "补一句" } });
    fireEvent.click(steerButton());

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
    fireEvent.click(steerButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toMatchObject({ text: "排队这条" });
    expect(screen.getByText("当前内核不支持实时引导，已改为排队")).toBeTruthy();
    // 降级后引导入口整体收掉，不再每轮重试 session.steer。
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
    fireEvent.click(steerButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(screen.getByText("当前内核不支持实时引导，已改为排队")).toBeTruthy();
  });

  it("keeps the draft when an attachment blocks steering instead of queueing it silently", async () => {
    const onSend = vi.fn();
    const onSteer = vi.fn().mockResolvedValue({ status: "queued" });
    const view = liveComposer(
      <GooseComposer onSteer={onSteer} onStop={vi.fn()} onSend={onSend} />,
    );

    fireEvent.change(messageInput(), { target: { value: "带附件的" } });
    const fileInput = document.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fireEvent.change(fileInput);

    await waitFor(() => expect(screen.getByText(/a\.txt/)).toBeTruthy());

    view.rerender(
      <MemoryRouter>
        <GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={onSend} />
      </MemoryRouter>,
    );

    const steer = steerButton();
    expect(steer.disabled).toBe(true);
    expect(steer.getAttribute("title")).toBe("附件不能随插话发送，只能用回车入队");

    fireEvent.keyDown(messageInput(), { key: "Enter", ctrlKey: true });

    await waitFor(() =>
      expect(screen.getByText(/附件不能随插话发送，按回车入队；内容仍留在输入框/)).toBeTruthy(),
    );
    expect(onSteer).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(messageInput().value).toBe("带附件的");
  });

  it("steers on Ctrl+Enter and keeps Enter for the queue", async () => {
    const onSend = vi.fn();
    const onSteer = vi.fn().mockResolvedValue({ status: "queued" });
    liveComposer(
      <GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={onSend} submitShortcut="enter" />,
    );

    const textarea = messageInput();
    fireEvent.change(textarea, { target: { value: "引导一条" } });

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    await Promise.resolve();
    expect(onSteer).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onSteer).toHaveBeenCalledWith("引导一条"));
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "入队一条" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toMatchObject({ text: "入队一条" });
  });

  it("renders stop, queue and steer actions side by side, and stop still fires onStop", () => {
    const onStop = vi.fn();
    liveComposer(<GooseComposer loading onStop={onStop} onSend={vi.fn()} />);

    const stopButton = screen.getByRole("button", { name: "中止响应" });
    expect(stopButton.getAttribute("title")).toBe("中止响应");
    expect(steerButton().getAttribute("title")).toBe(
      "立即引导（不打断当前轮，并入这一轮；Ctrl+Enter）",
    );
    expect(queueSendButton().getAttribute("title")).toBe(QUEUE_SEND_LABEL);

    fireEvent.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("refuses to submit an empty message while running", () => {
    const onSend = vi.fn();
    const onSteer = vi.fn();
    liveComposer(<GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={onSend} />);

    expect(steerButton().disabled).toBe(true);
    expect(queueSendButton().disabled).toBe(true);

    fireEvent.click(steerButton());
    fireEvent.click(queueSendButton());
    expect(onSteer).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("blocks whitespace-only text locally instead of calling the kernel", () => {
    const onSteer = vi.fn();
    liveComposer(<GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={vi.fn()} />);

    fireEvent.change(messageInput(), { target: { value: "   " } });
    expect(steerButton().disabled).toBe(true);
    fireEvent.click(steerButton());
    expect(onSteer).not.toHaveBeenCalled();
  });

  it("blocks built-in slash commands instead of steering them", async () => {
    const onSend = vi.fn();
    const onSteer = vi.fn();
    liveComposer(
      <GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={onSend} submitShortcut="enter" />,
    );

    const textarea = messageInput();
    fireEvent.change(textarea, { target: { value: "/compress" } });

    expect(steerButton().disabled).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    await Promise.resolve();

    expect(onSend).not.toHaveBeenCalled();
    expect(onSteer).not.toHaveBeenCalled();
    expect(screen.getAllByText(/需等当前回合结束再执行/)).toHaveLength(2);
  });

  it("shows the send-mode hint as soon as the agent is running", () => {
    liveComposer(<GooseComposer loading onStop={vi.fn()} onSend={vi.fn()} />);

    expect(screen.getByText(/回车入队（等本轮结束）/)).toBeTruthy();
    expect(screen.getByText(/Ctrl\+Enter 立即引导/)).toBeTruthy();
    expect(document.querySelector("[data-mode='queue-steer']")).toBeTruthy();
  });

  it("drops the steer key from the hint once the mode is steer-unavailable", async () => {
    const onSteer = vi
      .fn()
      .mockRejectedValue(
        new GatewayRpcError("agent does not support steer", { method: "session.steer", code: 4010 }),
      );
    liveComposer(<GooseComposer loading onSteer={onSteer} onStop={vi.fn()} onSend={vi.fn()} />);

    fireEvent.change(messageInput(), { target: { value: "老内核" } });
    fireEvent.click(steerButton());

    await waitFor(() => expect(screen.getByText(/本轮结束后自动发送/)).toBeTruthy());
    expect(document.querySelector("[data-mode='queue']")).toBeTruthy();
    expect(screen.queryByText(/Ctrl\+Enter 立即引导/)).toBeNull();
  });

  it("stops queueing at the per-session cap and says so", () => {
    const onSend = vi.fn();
    liveComposer(
      <GooseComposer loading queuedCount={8} onStop={vi.fn()} onSend={onSend} />,
    );

    fireEvent.change(messageInput(), { target: { value: "第 9 条" } });

    const sendButton = queueSendButton();
    expect(sendButton.disabled).toBe(true);
    expect(screen.getByText(/队列已满（上限 8 条）/)).toBeTruthy();
    expect(document.querySelector("[data-mode='full']")).toBeTruthy();

    fireEvent.click(sendButton);
    expect(onSend).not.toHaveBeenCalled();
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

describe("GooseComposer draft attachments", () => {
  afterEach(() => cleanup());

  function attachFile(name: string) {
    const fileInput = document.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["hello"], name, { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fireEvent.change(fileInput);
  }

  it("keeps attachments when the composer remounts for the same draft slot", async () => {
    const view = liveComposer(<GooseComposer draftKey="draft-cache-keep" />);
    attachFile("keep.txt");
    await waitFor(() => expect(screen.getByText(/keep\.txt/)).toBeTruthy());

    view.unmount();
    liveComposer(<GooseComposer draftKey="draft-cache-keep" />);

    expect(screen.getByText(/keep\.txt/)).toBeTruthy();
    writeDraftAttachments("draft-cache-keep", []);
  });

  it("does not leak one session's attachments into the next", async () => {
    const view = liveComposer(<GooseComposer draftKey="draft-cache-a" />);
    attachFile("only-in-a.txt");
    await waitFor(() => expect(screen.getByText(/only-in-a\.txt/)).toBeTruthy());

    view.unmount();
    liveComposer(<GooseComposer draftKey="draft-cache-b" />);

    expect(screen.queryByText(/only-in-a\.txt/)).toBeNull();
    writeDraftAttachments("draft-cache-a", []);
  });
});

describe("GooseComposer Escape", () => {
  afterEach(() => cleanup());

  it("stops the running turn on Escape", () => {
    const onStop = vi.fn();
    liveComposer(<GooseComposer loading onStop={onStop} onSend={vi.fn()} />);

    fireEvent.keyDown(messageInput(), { key: "Escape" });

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does nothing when idle and there is no popover to close", () => {
    const onStop = vi.fn();
    liveComposer(<GooseComposer onStop={onStop} onSend={vi.fn()} />);

    const event = fireEvent.keyDown(messageInput(), { key: "Escape" });

    expect(onStop).not.toHaveBeenCalled();
    expect(event).toBe(true);
  });
});

describe("GooseComposer sent history", () => {
  const draftKey = "history-test-slot";
  afterEach(() => {
    cleanup();
    forgetComposerHistory(draftKey);
  });

  async function sendText(text: string) {
    const textarea = messageInput();
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(messageInput().value).toBe(""));
  }

  it("recalls the previous sends with ArrowUp and walks back with ArrowDown", async () => {
    liveComposer(
      <GooseComposer draftKey={draftKey} submitShortcut="enter" onSend={vi.fn()} />,
    );

    await sendText("第一条");
    await sendText("第二条");

    const textarea = messageInput();
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await waitFor(() => expect(messageInput().value).toBe("第二条"));

    fireEvent.keyDown(messageInput(), { key: "ArrowUp" });
    await waitFor(() => expect(messageInput().value).toBe("第一条"));

    fireEvent.keyDown(messageInput(), { key: "ArrowUp" });
    await waitFor(() => expect(messageInput().value).toBe("第一条"));

    fireEvent.keyDown(messageInput(), { key: "ArrowDown" });
    await waitFor(() => expect(messageInput().value).toBe("第二条"));

    fireEvent.keyDown(messageInput(), { key: "ArrowDown" });
    await waitFor(() => expect(messageInput().value).toBe(""));
  });

  it("keeps a typed draft untouched", async () => {
    liveComposer(
      <GooseComposer draftKey={draftKey} submitShortcut="enter" onSend={vi.fn()} />,
    );
    await sendText("旧消息");

    fireEvent.change(messageInput(), { target: { value: "还在写的草稿" } });
    const event = fireEvent.keyDown(messageInput(), { key: "ArrowUp" });

    expect(messageInput().value).toBe("还在写的草稿");
    expect(event).toBe(true);
  });
});

describe("GooseComposer mention failure", () => {
  afterEach(() => cleanup());

  it("shows a retry row instead of an empty spinning panel", async () => {
    const completePath = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway offline"))
      .mockResolvedValue({ items: [{ text: "@file:src/app.tsx", display: "app.tsx" }] });

    liveComposer(<GooseComposer initial="@file:app" mentionPicker={{ completePath }} />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/引用检索失败/)).toBeTruthy();
    expect(messageInput().value).toBe("@file:app");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(screen.getByText("app.tsx")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(completePath).toHaveBeenCalledTimes(2);
  });
});

describe("GooseComposer oversized attachments", () => {
  afterEach(() => cleanup());

  it("reports files above the upload limit instead of dropping them silently", async () => {
    liveComposer(<GooseComposer />);
    const box = messageInput().closest("[data-flush-bottom]") as HTMLElement;
    const big = new File(["x"], "大文件.zip", { type: "application/zip" });
    Object.defineProperty(big, "size", { value: 60 * 1024 * 1024 });

    fireEvent.drop(box, {
      dataTransfer: { files: [big], types: ["Files"], getData: () => "" },
    });

    await waitFor(() => expect(screen.getByText(/超过单个附件上限 50 MB/)).toBeTruthy());
    expect(screen.queryByText("大文件.zip")).toBeNull();
  });

  it("formats the limit from the single source of truth", () => {
    expect(formatAttachmentBytes(MAX_ATTACHMENT_BYTES)).toBe("50 MB");
    expect(oversizedAttachmentNotice([{ name: "a.zip", size: 10 }])).toBe("");
    expect(oversizedAttachmentNotice([{ name: "a.zip", size: 60 * 1024 * 1024 }])).toContain(
      "「a.zip」",
    );
  });
});

describe("GooseComposer 断线红字", () => {
  afterEach(() => cleanup());

  function composerWith(blocked?: string) {
    return (
      <MemoryRouter>
        <GooseComposer initial="再发一次" sendBlockedReason={blocked} onSend={vi.fn()} />
      </MemoryRouter>
    );
  }

  it("连接恢复后撤掉被连接状态拦下的红字，不再指向已消失的横幅", () => {
    const { rerender } = render(composerWith("网关未连接，等重连成功再发"));

    fireEvent.keyDown(messageInput(), { key: "Enter", ctrlKey: true });
    expect(screen.getByText("网关未连接，等重连成功再发")).toBeTruthy();

    rerender(composerWith(undefined));
    expect(screen.queryByText("网关未连接，等重连成功再发")).toBeNull();
  });

  it("不清掉与连接无关的发送错误", () => {
    const { rerender } = render(
      <MemoryRouter>
        <GooseComposer initial="/compress" loading onStop={vi.fn()} onSend={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.keyDown(messageInput(), { key: "Enter", ctrlKey: true });
    expect(
      screen.getAllByText("Agent 运行中，/compress 需等当前回合结束再执行").length,
    ).toBeGreaterThan(0);

    rerender(
      <MemoryRouter>
        <GooseComposer initial="/compress" onSend={vi.fn()} />
      </MemoryRouter>,
    );
    expect(
      screen.getAllByText("Agent 运行中，/compress 需等当前回合结束再执行").length,
    ).toBeGreaterThan(0);
  });
});
