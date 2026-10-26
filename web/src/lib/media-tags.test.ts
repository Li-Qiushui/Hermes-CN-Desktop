import { describe, expect, it } from "vitest";

import { extractMediaTags, mediaKindOfPath, stripMediaTags } from "./media-tags";

describe("extractMediaTags", () => {
  it("行首裸标记整行剥掉，不留空行", () => {
    const result = extractMediaTags(["开头一行", "MEDIA:/tmp/shot.png", "结尾一行"].join("\n"));

    expect(result.items).toEqual([{ path: "/tmp/shot.png", kind: "image", name: "shot.png" }]);
    expect(result.text).toBe("开头一行\n结尾一行");
  });

  it("句中标记只切走路径，保留前后正文", () => {
    const result = extractMediaTags("看这张 MEDIA:/tmp/a.png 就好了，别外传");

    expect(result.items.map((item) => item.path)).toEqual(["/tmp/a.png"]);
    expect(result.text).toBe("看这张 就好了，别外传");
  });

  it("单引号、双引号、反引号包裹的含空格路径都能取到", () => {
    const result = extractMediaTags(
      [
        "MEDIA:'/Users/li qiushui/My Files/片 1.png'",
        'MEDIA:"/Users/li qiushui/clip 2.mp4"',
        "MEDIA:`/Users/li qiushui/voice 3.mp3`",
      ].join("\n"),
    );

    expect(result.items).toEqual([
      { path: "/Users/li qiushui/My Files/片 1.png", kind: "image", name: "片 1.png" },
      { path: "/Users/li qiushui/clip 2.mp4", kind: "video", name: "clip 2.mp4" },
      { path: "/Users/li qiushui/voice 3.mp3", kind: "audio", name: "voice 3.mp3" },
    ]);
    expect(result.text).toBe("");
  });

  it("围栏代码块里的标记同样提取，空掉的围栏一起删掉", () => {
    const result = extractMediaTags(["说明：", "", "```text", "MEDIA:/tmp/plot.png", "```"].join("\n"));

    expect(result.items).toEqual([{ path: "/tmp/plot.png", kind: "image", name: "plot.png" }]);
    expect(result.text).toBe("说明：");
  });

  it("Windows 绝对路径（含空格）不截断", () => {
    const result = extractMediaTags("MEDIA:C:\\Users\\Li Qiushui\\Pictures\\屏幕 截图 2026.PNG");

    expect(result.items).toEqual([
      {
        path: "C:\\Users\\Li Qiushui\\Pictures\\屏幕 截图 2026.PNG",
        kind: "image",
        name: "屏幕 截图 2026.PNG",
      },
    ]);
    expect(result.text).toBe("");
  });

  it("一条消息多个标记按出现顺序返回，同一路径去重", () => {
    const result = extractMediaTags(
      [
        "MEDIA:/tmp/a.mp3",
        "MEDIA:/tmp/b.html",
        "MEDIA:/tmp/a.mp3",
        "",
        "MEDIA:/tmp/c.zip",
      ].join("\n"),
    );

    expect(result.items).toEqual([
      { path: "/tmp/a.mp3", kind: "audio", name: "a.mp3" },
      { path: "/tmp/b.html", kind: "html", name: "b.html" },
      { path: "/tmp/c.zip", kind: "file", name: "c.zip" },
    ]);
    expect(result.text).toBe("");
  });

  it("大写扩展名与各类 kind 都认", () => {
    expect(mediaKindOfPath("/tmp/A.WEBP")).toBe("image");
    expect(mediaKindOfPath("/tmp/B.WAV")).toBe("audio");
    expect(mediaKindOfPath("/tmp/C.MKV")).toBe("video");
    expect(mediaKindOfPath("/tmp/D.HTM")).toBe("html");
    expect(mediaKindOfPath("/tmp/E.tar.gz")).toBe("file");
    expect(mediaKindOfPath("/tmp/README")).toBe("file");
  });

  it("没有标记时原样返回，空白和换行都不动", () => {
    const text = "普通段落\n\n第二段 MEDIA 字样但没有冒号路径";
    expect(extractMediaTags(text)).toEqual({ text, items: [] });
    expect(stripMediaTags("裸图片路径 /tmp/a.png 保留")).toBe("裸图片路径 /tmp/a.png 保留");
  });

  it("流式输出里只打了一半的标记不被误删", () => {
    expect(extractMediaTags("MEDIA:/tmp/half")).toEqual({ text: "MEDIA:/tmp/half", items: [] });
    expect(extractMediaTags("MEDIA:/tmp/half.pn").items).toEqual([
      { path: "/tmp/half.pn", kind: "file", name: "half.pn" },
    ]);
  });

  it("同行紧跟两个标记也能各自切干净", () => {
    const result = extractMediaTags("MEDIA:/tmp/a.png MEDIA:/tmp/b.mp4");

    expect(result.items.map((item) => item.path)).toEqual(["/tmp/a.png", "/tmp/b.mp4"]);
    expect(result.text).toBe("");
  });
});
