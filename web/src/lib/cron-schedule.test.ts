import { describe, expect, it } from "vitest";
import {
  CRON_PRESETS,
  DEFAULT_SCHEDULE_EXPR,
  cronParts,
  presetExprFor,
  presetForExpr,
  scheduleBadgeText,
  scheduleSummary,
  validateCronExpr,
} from "./cron-schedule";

describe("cron 调度预设", () => {
  it("7 个预设，6 个带表达式、自定义无表达式", () => {
    expect(CRON_PRESETS).toHaveLength(7);
    expect(CRON_PRESETS.map((preset) => preset.value)).toEqual([
      "daily",
      "weekdays",
      "weekly",
      "monthly",
      "hourly",
      "every-15-minutes",
      "custom",
    ]);
    expect(presetExprFor("daily")).toBe("0 9 * * *");
    expect(presetExprFor("weekdays")).toBe("0 9 * * 1-5");
    expect(presetExprFor("weekly")).toBe("0 9 * * 1");
    expect(presetExprFor("monthly")).toBe("0 9 1 * *");
    expect(presetExprFor("hourly")).toBe("0 * * * *");
    expect(presetExprFor("every-15-minutes")).toBe("*/15 * * * *");
    expect(presetExprFor("custom")).toBeNull();
  });

  it("默认表达式就是每天 9:00", () => {
    expect(DEFAULT_SCHEDULE_EXPR).toBe("0 9 * * *");
    expect(presetForExpr(DEFAULT_SCHEDULE_EXPR).value).toBe("daily");
  });

  it("每个预设表达式都能反解回同一个预设", () => {
    for (const preset of CRON_PRESETS) {
      if (!preset.expr) continue;
      expect(presetForExpr(preset.expr).value).toBe(preset.value);
      expect(presetForExpr(`  ${preset.expr}  `).value).toBe(preset.value);
    }
  });

  it("非预设的同形状表达式按结构反解", () => {
    expect(presetForExpr("30 8 * * *").value).toBe("daily");
    expect(presetForExpr("0 18 * * 1-5").value).toBe("weekdays");
    expect(presetForExpr("15 7 * * 3").value).toBe("weekly");
    expect(presetForExpr("0 10 15 * *").value).toBe("monthly");
    expect(presetForExpr("30 * * * *").value).toBe("hourly");
  });

  it("结构不匹配或段数不对时归为自定义", () => {
    expect(presetForExpr("*/5 * * * *").value).toBe("custom");
    expect(presetForExpr("0 9 * * 1,3,5").value).toBe("custom");
    expect(presetForExpr("0 9 * *").value).toBe("custom");
    expect(presetForExpr("").value).toBe("custom");
  });

  it("cronParts 只接受 5 段", () => {
    expect(cronParts("0  9 * *  *")).toEqual(["0", "9", "*", "*", "*"]);
    expect(cronParts("0 9 * *")).toBeNull();
    expect(cronParts("0 9 * * * *")).toBeNull();
  });
});

describe("中文调度摘要", () => {
  it("预设摘要", () => {
    expect(scheduleSummary("0 9 * * *")).toBe("每天 09:00");
    expect(scheduleSummary("0 9 * * 1-5")).toBe("每个工作日 09:00");
    expect(scheduleSummary("0 9 * * 1")).toBe("每周一 09:00");
    expect(scheduleSummary("0 9 1 * *")).toBe("每月 1 日 09:00");
    expect(scheduleSummary("0 * * * *")).toBe("每小时整点");
    expect(scheduleSummary("*/15 * * * *")).toBe("每 15 分钟");
  });

  it("自定义表达式给出人话摘要", () => {
    expect(scheduleSummary("30 8 * * *")).toBe("每天 08:30");
    expect(scheduleSummary("*/10 * * * *")).toBe("每 10 分钟");
    expect(scheduleSummary("30 * * * *")).toBe("每小时第 30 分");
    expect(scheduleSummary("0 9 * * 1,3,5")).toBe("每周一、周三、周五 09:00");
    expect(scheduleSummary("0 9 * * 6,0")).toBe("每周六、周日 09:00");
    expect(scheduleSummary("0 8 15 * *")).toBe("每月 15 日 08:00");
    expect(scheduleSummary("0 8 1 6 *")).toBe("每年 6 月 1 日 08:00");
    expect(scheduleSummary("0 */2 * * *")).toBe("每 2 小时整点");
  });

  it("空与残缺表达式不装懂", () => {
    expect(scheduleSummary("")).toBe("尚未设置调度");
    expect(scheduleSummary("0 9 * *")).toBe("表达式格式不完整：0 9 * *");
  });

  it("徽标文本带原文表达式", () => {
    expect(scheduleBadgeText("0 9 * * 1-5")).toBe("每个工作日 09:00（0 9 * * 1-5）");
    expect(scheduleBadgeText("")).toBe("尚未设置调度");
  });
});

describe("调度表达式校验", () => {
  it("合法表达式通过", () => {
    expect(validateCronExpr("0 9 * * *")).toBeNull();
    expect(validateCronExpr("*/15 * * * *")).toBeNull();
    expect(validateCronExpr("0 9 * * 1-5")).toBeNull();
    expect(validateCronExpr("0 0 1 1 *")).toBeNull();
    expect(validateCronExpr("5,35 */2 1-15 * 0-6")).toBeNull();
  });

  it("空值给出示例", () => {
    expect(validateCronExpr("")).toBe("请填写调度表达式，例如 0 9 * * *");
  });

  it("段数不对时报出实际段数", () => {
    expect(validateCronExpr("0 9 * *")).toBe("调度表达式需要 5 段（分 时 日 月 周），当前 4 段");
    expect(validateCronExpr("0 9 * * * *")).toBe("调度表达式需要 5 段（分 时 日 月 周），当前 6 段");
  });

  it("字段越界报出字段名和取值范围", () => {
    expect(validateCronExpr("0 90 * * *")).toBe("小时字段取值「90」超出 0-23 范围");
    expect(validateCronExpr("70 9 * * *")).toBe("分钟字段取值「70」超出 0-59 范围");
    expect(validateCronExpr("0 9 32 * *")).toBe("日字段取值「32」超出 1-31 范围");
    expect(validateCronExpr("0 9 * 13 *")).toBe("月字段取值「13」超出 1-12 范围");
    expect(validateCronExpr("0 9 * * 8")).toBe("星期字段取值「8」超出 0-7 范围");
  });

  it("非法字符、坏步长、倒挂区间各有红字", () => {
    expect(validateCronExpr("0 9 * * ?")).toBe("星期字段含非法字符：?（只允许数字、* / , -）");
    expect(validateCronExpr("*/0 * * * *")).toBe("分钟字段的步长「0」无效，应为大于 0 的整数");
    expect(validateCronExpr("0 9-3 * * *")).toBe("小时字段的区间「9-3」起点大于终点");
    expect(validateCronExpr("a 9 * * *")).toBe("分钟字段含非法字符：a（只允许数字、* / , -）");
  });
});
