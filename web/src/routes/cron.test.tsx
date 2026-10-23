// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";

const h = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  runSessions: [] as Array<Record<string, unknown>>,
  deliveryTargets: [] as Array<Record<string, unknown>>,
  deliveryTargetsError: false,
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  actionMutate: vi.fn(),
  deleteMutate: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/hooks/use-cron", () => ({
  cronJobProfile: (job: { profile?: string; profile_name?: string } | null | undefined) =>
    job?.profile || job?.profile_name || "default",
  useCronJobs: () => ({
    data: h.jobs,
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
    refetch: h.refetch,
  }),
  useCronRuns: () => ({
    data: h.runs,
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
    refetch: h.refetch,
  }),
  useCronRunSessions: () => ({ data: h.runSessions, refetch: h.refetch }),
  useCronRunDetail: () => ({ data: null, isLoading: false, isError: false, error: null }),
  useCronDeliveryTargets: () => ({
    data: h.deliveryTargets,
    isError: h.deliveryTargetsError,
    isLoading: false,
  }),
  useCreateCronJob: () => ({ mutate: h.createMutate, isPending: false }),
  useUpdateCronJob: () => ({ mutate: h.updateMutate, isPending: false }),
  useCronAction: () => ({ mutate: h.actionMutate, isPending: false }),
  useDeleteCronJob: () => ({ mutate: h.deleteMutate, isPending: false }),
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => "default",
  useProfiles: () => ({ data: [{ name: "default" }, { name: "work" }], isLoading: false, isError: false }),
}));

vi.mock("@/lib/use-confirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => true), prompt: vi.fn() }),
}));

import { CronRoute } from "./cron";

const JOB = {
  id: "job_daily",
  name: "每日巡检",
  prompt: "跑一次健康检查",
  schedule: "0 9 * * 1-5",
  deliver: "local",
  enabled: true,
  state: "scheduled",
  profile: "default",
  model: "deepseek-v4-flash",
  last_run_at: "2026-10-22T09:00:00+08:00",
  next_run_at: "2026-10-24T09:00:00+08:00",
  last_status: "ok",
};

const RUN = {
  job_id: "job_daily",
  profile: "default",
  filename: "2026-10-23_09-00-00.md",
  started_at: "2026-10-23T09:00:00+08:00",
  status: "success",
  summary: "检查完成",
  size_bytes: 2048,
};

const TARGETS = [
  { id: "local", name: "Local (save only)", homeTargetSet: true, homeEnvVar: null },
  { id: "feishu", name: "Feishu", homeTargetSet: true, homeEnvVar: null },
  { id: "weixin", name: "Weixin", homeTargetSet: false, homeEnvVar: null },
];

function TaskProbe() {
  const { taskId } = useParams();
  return <div>会话 {taskId}</div>;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function app() {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/cron"]}>
        <Routes>
          <Route path="/cron" element={<CronRoute />} />
          <Route path="/tasks/:taskId" element={<TaskProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderRoute() {
  return render(app());
}

async function waitForDetail() {
  await waitFor(() => expect(screen.getByRole("button", { name: /立即运行/ })).toBeTruthy());
}

beforeEach(() => {
  h.jobs = [JOB];
  h.runs = [RUN];
  h.runSessions = [];
  h.deliveryTargets = TARGETS;
  h.deliveryTargetsError = false;
  for (const fn of [h.createMutate, h.updateMutate, h.actionMutate, h.deleteMutate, h.refetch]) {
    fn.mockReset();
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("cron 编辑任务", () => {
  it("编辑后保存调用 PUT，字段含名称/调度/多选投递/模型", async () => {
    renderRoute();
    await waitForDetail();

    fireEvent.click(screen.getByRole("button", { name: /^编辑$/ }));
    const nameInput = screen.getByLabelText("任务名称") as HTMLInputElement;
    expect(nameInput.value).toBe("每日巡检");
    expect((screen.getByLabelText("调度表达式") as HTMLInputElement).value).toBe("0 9 * * 1-5");
    expect(screen.getAllByText("每个工作日 09:00").length).toBeGreaterThan(0);

    fireEvent.change(nameInput, { target: { value: "每日巡检 v2" } });
    fireEvent.click(screen.getByLabelText(/飞书/));
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(h.updateMutate).toHaveBeenCalledTimes(1);
    const [vars] = h.updateMutate.mock.calls[0] as [{ id: string; profile: string; updates: Record<string, unknown> }];
    expect(vars.id).toBe("job_daily");
    expect(vars.profile).toBe("default");
    expect(vars.updates).toMatchObject({
      name: "每日巡检 v2",
      prompt: "跑一次健康检查",
      schedule: "0 9 * * 1-5",
      deliver: "local,feishu",
      model: "deepseek-v4-flash",
    });
  });

  it("保存失败显示后端原文且不关窗", async () => {
    h.updateMutate.mockImplementation((_vars: unknown, options: { onError: (error: Error) => void }) => {
      options.onError(new Error('HTTP 400: {"detail":"schedule 无法解析"}'));
    });
    renderRoute();
    await waitForDetail();

    fireEvent.click(screen.getByRole("button", { name: /^编辑$/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(screen.getByText("schedule 无法解析")).toBeTruthy());
    expect(screen.getByLabelText("任务名称")).toBeTruthy();
  });

  it("编辑时关掉启用会调用暂停接口", async () => {
    h.updateMutate.mockImplementation((_vars: unknown, options: { onSuccess: (job: unknown) => void }) => {
      options.onSuccess({ ...JOB });
    });
    renderRoute();
    await waitForDetail();

    fireEvent.click(screen.getByRole("button", { name: /^编辑$/ }));
    fireEvent.click(screen.getByLabelText("启用任务"));
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(h.actionMutate).toHaveBeenCalledWith(
      { id: "job_daily", profile: "default", action: "pause" },
      expect.anything(),
    );
  });

  it("暂停状态的任务打开编辑能看到未启用", async () => {
    h.jobs = [{ ...JOB, enabled: false, state: "paused" }];
    renderRoute();
    await waitForDetail();
    fireEvent.click(screen.getByRole("button", { name: /^编辑$/ }));
    expect((screen.getByLabelText("启用任务") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("暂停（保存后不触发）")).toBeTruthy();
  });
});

describe("cron 新建任务", () => {
  it("预设切成工作日会写入表达式并显示中文摘要", async () => {
    renderRoute();
    await waitForDetail();
    fireEvent.click(screen.getByRole("button", { name: /新建任务/ }));

    fireEvent.change(screen.getByLabelText("调度频率"), { target: { value: "weekdays" } });
    expect((screen.getByLabelText("调度表达式") as HTMLInputElement).value).toBe("0 9 * * 1-5");
    expect(screen.getAllByText("每个工作日 09:00").length).toBeGreaterThan(0);
  });

  it("非法表达式给红字且不提交", async () => {
    renderRoute();
    await waitForDetail();
    fireEvent.click(screen.getByRole("button", { name: /新建任务/ }));

    fireEvent.change(screen.getByLabelText("任务提示词"), { target: { value: "检查磁盘" } });
    fireEvent.change(screen.getByLabelText("调度频率"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("调度表达式"), { target: { value: "0 90 * * *" } });
    expect(screen.getByText("小时字段取值「90」超出 0-23 范围")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    expect(h.createMutate).not.toHaveBeenCalled();
  });

  it("提示词为空时红字提示并拦住提交", async () => {
    renderRoute();
    await waitForDetail();
    fireEvent.click(screen.getByRole("button", { name: /新建任务/ }));
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    expect(screen.getByText("请填写任务提示词，定时执行时会原样发给 Agent")).toBeTruthy();
    expect(h.createMutate).not.toHaveBeenCalled();
  });

  it("多选投递后创建，body 是逗号串", async () => {
    h.createMutate.mockImplementation((_vars: unknown, options: { onSuccess: (job: unknown) => void }) => {
      options.onSuccess({ ...JOB, id: "job_new", name: "磁盘巡检" });
    });
    renderRoute();
    await waitForDetail();
    fireEvent.click(screen.getByRole("button", { name: /新建任务/ }));

    fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "磁盘巡检" } });
    fireEvent.change(screen.getByLabelText("任务提示词"), { target: { value: "检查磁盘占用" } });
    fireEvent.change(screen.getByLabelText("调度频率"), { target: { value: "hourly" } });
    fireEvent.click(screen.getByLabelText(/微信/));
    fireEvent.click(screen.getByLabelText(/飞书/));
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));

    expect(h.createMutate).toHaveBeenCalledTimes(1);
    const [vars] = h.createMutate.mock.calls[0] as [Record<string, unknown>];
    expect(vars).toMatchObject({
      name: "磁盘巡检",
      prompt: "检查磁盘占用",
      schedule: "0 * * * *",
      deliver: "local,weixin,feishu",
      profile: "default",
    });
    await waitFor(() => expect(screen.queryByLabelText("任务名称")).toBeNull());
  });

  it("后端目标不可用时降级为 4 项并标注未探测到", async () => {
    h.deliveryTargets = [];
    h.deliveryTargetsError = true;
    renderRoute();
    await waitForDetail();
    fireEvent.click(screen.getByRole("button", { name: /新建任务/ }));

    expect(screen.getByText(/未探测到后端目标/)).toBeTruthy();
    expect(screen.getByLabelText(/飞书/)).toBeTruthy();
    expect(screen.getByLabelText(/微信/)).toBeTruthy();
    expect(screen.getByLabelText(/Email/)).toBeTruthy();
  });
});

describe("cron 排队中与运行历史", () => {
  it("立即执行后立刻出现排队伪行", async () => {
    h.actionMutate.mockImplementation((_vars: unknown, options: { onSuccess: (job: unknown) => void }) => {
      options.onSuccess({ ...JOB });
    });
    renderRoute();
    await waitForDetail();

    fireEvent.click(screen.getByRole("button", { name: /立即运行/ }));
    expect(screen.getByText("排队中")).toBeTruthy();
    expect(screen.getByText(/已等待 \d+ 秒/)).toBeTruthy();
  });

  it("90 秒还没落地就转失败提示并撤掉伪行", async () => {
    vi.useFakeTimers();
    h.actionMutate.mockImplementation((_vars: unknown, options: { onSuccess: (job: unknown) => void }) => {
      options.onSuccess({ ...JOB });
    });
    renderRoute();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: /立即运行/ }));
    expect(screen.getByText("排队中")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(91_000);
    });

    expect(screen.queryByText("排队中")).toBeNull();
    expect(screen.getByText(/已等待 90 秒仍未出现运行记录/)).toBeTruthy();
  });

  it("轮询到真实 run 后排队行被替换", async () => {
    vi.useFakeTimers();
    h.actionMutate.mockImplementation((_vars: unknown, options: { onSuccess: (job: unknown) => void }) => {
      options.onSuccess({ ...JOB });
    });
    const view = renderRoute();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: /立即运行/ }));
    expect(screen.getByText("排队中")).toBeTruthy();

    h.runs = [{ ...RUN, started_at: new Date(Date.now() + 1_000).toISOString() }];
    view.rerender(app());

    await act(async () => {
      vi.advanceTimersByTime(3_100);
    });

    expect(screen.queryByText("排队中")).toBeNull();
    expect(screen.getByText("运行已落地，运行历史已刷新。")).toBeTruthy();
  });

  it("有落库会话的 run 点击后跳到 /tasks/:id", async () => {
    const startedMs = Date.parse(RUN.started_at);
    h.runSessions = [
      {
        id: "cron_job_daily_20261023_090000",
        title: "巡检",
        source: "cron",
        startedAtMs: startedMs,
        lastActiveMs: startedMs + 120_000,
        endedAtMs: startedMs + 180_000,
      },
    ];
    renderRoute();
    await waitForDetail();

    fireEvent.click(screen.getByRole("button", { name: /检查完成/ }));
    await waitFor(() =>
      expect(screen.getByText("会话 cron_job_daily_20261023_090000")).toBeTruthy(),
    );
  });

  it("没有会话的 run 保持只读输出", async () => {
    renderRoute();
    await waitForDetail();
    expect(screen.getByText(/仅输出/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "输出" })).toBeNull();
  });
});
