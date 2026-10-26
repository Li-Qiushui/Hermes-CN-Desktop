// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ChatMediaItem } from "./chat-types";

const readLocalDataUrl = vi.fn<(path: string) => Promise<string>>();
const fetchMediaDataUrl = vi.fn<(path: string) => Promise<string>>();

vi.mock("@/lib/local-file-read", () => ({
  readLocalDataUrl: (path: string) => readLocalDataUrl(path),
  readLocalTextFile: vi.fn(),
}));

vi.mock("@/lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/transport")>();
  return {
    ...actual,
    fetchMediaDataUrl: (path: string) => fetchMediaDataUrl(path),
  };
});

const { MediaBlock } = await import("./media-block");

const AUDIO_DATA_URL = "data:audio/mpeg;base64,QUJD";
const VIDEO_DATA_URL = "data:video/mp4;base64,REVG";
const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const SVG_BASE64_DATA_URL = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
const SVG_UTF8_DATA_URL = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>";

const item = (over: Partial<ChatMediaItem> = {}): ChatMediaItem => ({
  path: "/tmp/voice.mp3",
  kind: "audio",
  name: "voice.mp3",
  ...over,
});

beforeEach(() => {
  readLocalDataUrl.mockReset();
  fetchMediaDataUrl.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MediaBlock", () => {
  it("音频 MEDIA 渲染成带 controls 的 audio 元素", async () => {
    readLocalDataUrl.mockResolvedValue(AUDIO_DATA_URL);
    const { container } = render(<MediaBlock items={[item()]} />);

    expect(container.querySelector("audio")).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();

    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    const audio = container.querySelector("audio") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toBe(AUDIO_DATA_URL);
    expect(audio.hasAttribute("controls")).toBe(true);
    expect(audio.getAttribute("aria-label")).toBe("voice.mp3");
    expect(readLocalDataUrl).toHaveBeenCalledWith("/tmp/voice.mp3");
  });

  it("视频 MEDIA 渲染成带 controls 与 playsInline 的 video 元素", async () => {
    readLocalDataUrl.mockResolvedValue(VIDEO_DATA_URL);
    const { container } = render(
      <MediaBlock items={[item({ path: "/tmp/clip.mp4", kind: "video", name: "clip.mp4" })]} />,
    );

    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe(VIDEO_DATA_URL);
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
  });

  it("图片 MEDIA 交给现有 MessageImage 渲染", async () => {
    fetchMediaDataUrl.mockResolvedValue(IMAGE_DATA_URL);
    const { container } = render(
      <MediaBlock items={[item({ path: "/tmp/shot.png", kind: "image", name: "shot.png" })]} />,
    );

    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(IMAGE_DATA_URL);
    });
    expect(screen.getByRole("button", { name: "查看大图：shot.png" })).toBeTruthy();
    expect(fetchMediaDataUrl).toHaveBeenCalledWith("/tmp/shot.png");
    expect(readLocalDataUrl).not.toHaveBeenCalled();
  });

  it("读取失败时出中文降级卡：文件名 + 复制路径", async () => {
    readLocalDataUrl.mockRejectedValue(new Error("boom"));
    render(<MediaBlock items={[item({ path: "/tmp/gone.mp3", name: "gone.mp3" })]} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("音频加载失败");
    expect(alert.textContent).toContain("gone.mp3");
    expect(screen.getByRole("button", { name: "复制路径" })).toBeTruthy();
  });

  it("html / file 出文件卡，不嵌 iframe", async () => {
    const { container } = render(
      <MediaBlock
        items={[
          item({ path: "/tmp/report.html", kind: "html", name: "report.html" }),
          item({ path: "/tmp/bundle.zip", kind: "file", name: "bundle.zip" }),
        ]}
      />,
    );

    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText("report.html")).toBeTruthy();
    expect(screen.getByText("HTML 文件")).toBeTruthy();
    expect(screen.getByText("HTML")).toBeTruthy();
    expect(screen.getByText("bundle.zip")).toBeTruthy();
    expect(screen.getByText("ZIP")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "复制路径" })).toHaveLength(2);
    expect(readLocalDataUrl).not.toHaveBeenCalled();
  });

  it("svg MEDIA 内联成 img，不走降级卡也不进大图弹层", async () => {
    fetchMediaDataUrl.mockResolvedValue(SVG_BASE64_DATA_URL);
    const { container } = render(
      <MediaBlock
        items={[item({ path: "/tmp/demo.svg", kind: "image", name: "demo.svg" })]}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(SVG_BASE64_DATA_URL);
    });
    expect(screen.queryByText("图片加载失败")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /查看大图/ })).toBeNull();
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("demo.svg");
  });

  it("URL 编码形态的 svg data URL 同样内联", async () => {
    fetchMediaDataUrl.mockResolvedValue(SVG_UTF8_DATA_URL);
    const { container } = render(
      <MediaBlock
        items={[item({ path: "/tmp/demo.svg", kind: "image", name: "demo.svg" })]}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(SVG_UTF8_DATA_URL);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("svg 内联破图后退回降级卡：文件名 + 路径 + 复制路径", async () => {
    fetchMediaDataUrl.mockResolvedValue(SVG_BASE64_DATA_URL);
    const { container } = render(
      <MediaBlock
        items={[item({ path: "/tmp/demo.svg", kind: "image", name: "demo.svg" })]}
      />,
    );

    const img = await waitFor(() => {
      const node = container.querySelector("img");
      expect(node).not.toBeNull();
      return node as HTMLImageElement;
    });
    fireEvent.error(img);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("图片加载失败");
    expect(alert.textContent).toContain("demo.svg");
    expect(alert.textContent).toContain("/tmp/demo.svg");
    expect(screen.getByRole("button", { name: "复制路径" })).toBeTruthy();
  });

  it("图片读取失败时出降级卡而不是破图", async () => {
    fetchMediaDataUrl.mockRejectedValue(new Error("boom"));
    render(
      <MediaBlock
        items={[item({ path: "/tmp/gone.png", kind: "image", name: "gone.png" })]}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("图片加载失败");
    expect(alert.textContent).toContain("gone.png");
    expect(alert.textContent).toContain("/tmp/gone.png");
  });
});
