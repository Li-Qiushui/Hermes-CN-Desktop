import { describe, expect, it } from "vitest";
import {
  isKernelSystemMessageText,
  splitKernelSystemTail,
  translateKernelSystemMessage,
} from "./system-message-i18n";

describe("内核系统文案中文化", () => {
  it("把「请求未被执行」翻成中文", () => {
    expect(
      translateKernelSystemMessage(
        "Your request was not processed. Send it again if you still want me to carry it out.",
      ),
    ).toEqual({
      kind: "request-not-processed",
      text: "本次请求未被执行，如果还需要，请重新发送。",
      interrupted: true,
    });
  });

  it("等待模型响应的中断句保留耗时数字", () => {
    expect(
      translateKernelSystemMessage("Operation interrupted: waiting for model response (0.6s elapsed)."),
    ).toEqual({
      kind: "interrupted-waiting-model",
      text: "已中断（等待模型响应 0.6 秒）。",
      interrupted: true,
    });
    expect(
      translateKernelSystemMessage("Operation interrupted: waiting for model response (12.4s elapsed).")?.text,
    ).toBe("已中断（等待模型响应 12.4 秒）。");
  });

  it("处理 API 错误的中断句保留错误类型与原文", () => {
    expect(
      translateKernelSystemMessage(
        "Operation interrupted: handling API error (APIStatusError: 400 invalid model).",
      ),
    ).toEqual({
      kind: "interrupted-api-error",
      text: "已中断（处理 API 错误：APIStatusError: 400 invalid model）。",
      interrupted: true,
    });
  });

  it("重试类中断句保留重试计数", () => {
    expect(
      translateKernelSystemMessage("Operation interrupted: retrying API call after error (retry 2/3).")?.text,
    ).toBe("已中断（API 调用出错后重试第 2/3 次）。");
    expect(
      translateKernelSystemMessage("Operation interrupted: retrying empty response from model (retry 1/2).")?.text,
    ).toBe("已中断（模型返回空响应，重试第 1/2 次）。");
  });

  it("供应商恢复与 retry 期间的中断句也覆盖", () => {
    expect(
      translateKernelSystemMessage(
        "Operation interrupted: waiting for the provider to recover (cycle 2/5).",
      )?.text,
    ).toBe("已中断（等待服务商恢复，第 2/5 轮）。");
    expect(
      translateKernelSystemMessage(
        "Operation interrupted during retry (provider timeout, attempt 3/4).",
      )?.text,
    ).toBe("已中断（重试中断：provider timeout，第 3/4 次）。");
  });

  it("普通回答一律不翻，返回 null", () => {
    expect(translateKernelSystemMessage("三种排序算法里快排平均最快。")).toBeNull();
    expect(translateKernelSystemMessage("Operation interrupted: something new happened.")).toBeNull();
    expect(translateKernelSystemMessage("")).toBeNull();
    expect(isKernelSystemMessageText("使用了 2 个工具")).toBe(false);
  });

  it("能从中断句前面切出正文，尾部换成中文", () => {
    const split = splitKernelSystemTail(
      "先说结论：快排更快。\n\nOperation interrupted: waiting for model response (0.6s elapsed).",
    );
    expect(split?.head).toBe("先说结论：快排更快。");
    expect(split?.tail.text).toBe("已中断（等待模型响应 0.6 秒）。");
    expect(splitKernelSystemTail("没有任何中断句")).toBeNull();
  });
});
