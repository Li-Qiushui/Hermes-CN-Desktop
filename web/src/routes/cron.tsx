import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileText,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import type { CronJob, CronRun } from "@hermes/protocol";
import { LoadingState, StatusDot } from "@hermes/shared-ui";
import { useActiveProfileName, useProfiles } from "@/hooks/use-profiles";
import {
  cronJobProfile,
  useCreateCronJob,
  useCronAction,
  useCronDeliveryTargets,
  useCronJobs,
  useCronRunDetail,
  useCronRunSessions,
  useCronRuns,
  useDeleteCronJob,
  useUpdateCronJob,
} from "@/hooks/use-cron";
import { FALLBACK_DELIVERY_TARGETS, deliverySummary } from "@/lib/cron-delivery";
import { DEFAULT_SCHEDULE_EXPR, presetForExpr, scheduleSummary } from "@/lib/cron-schedule";
import { type CronEditorValues, createPayload, enabledAction, updatePayload } from "@/lib/cron-editor";
import {
  backendErrorMessage,
  pendingRunExpired,
  pendingRunSettled,
  runStartedMs,
  sessionIdForRun,
} from "@/lib/cron-runs";
import { CronJobEditor } from "@/components/cron/cron-job-editor";
import { PendingRunRow } from "@/components/cron/pending-run-row";
import { useConfirm } from "@/lib/use-confirm";
import { SectionShell } from "./section-shell";
import s from "./cron.module.css";

type StatusFilter = "all" | "active" | "paused" | "error" | "completed";
type FeedbackTone = "ok" | "info" | "error";

interface Feedback {
  tone: FeedbackTone;
  message: string;
}

interface PendingTrigger {
  key: string;
  requestedAt: number;
}

type EditorState = { mode: "create" } | { mode: "edit"; job: CronJob } | null;

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "active", label: "活跃" },
  { value: "paused", label: "暂停" },
  { value: "error", label: "异常" },
  { value: "completed", label: "完成" },
];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function titleOf(job: CronJob): string {
  return text(job.name) || text(job.prompt).slice(0, 80) || text(job.script).slice(0, 80) || job.id;
}

function promptPreview(job: CronJob): string {
  return text(job.prompt) || (text(job.script) ? `脚本：${text(job.script)}` : "无任务描述");
}

function jobScheduleExpr(job: CronJob): string {
  const schedule = job.schedule;
  if (typeof schedule === "string") return text(schedule);
  if (schedule && typeof schedule === "object") {
    return text(schedule.expr) || text(schedule.value);
  }
  return "";
}

function scheduleDisplay(job: CronJob): string {
  const expr = jobScheduleExpr(job);
  if (expr) return scheduleSummary(expr);
  return text(job.schedule_display) || "未设置";
}

function jobModel(job: CronJob): string {
  return text((job as Record<string, unknown>).model);
}

function jobState(job: CronJob): string {
  return text(job.state) || (job.enabled ? "scheduled" : "paused");
}

function isPaused(job: CronJob): boolean {
  return !job.enabled || jobState(job) === "paused";
}

function statusLabel(job: CronJob): string {
  const state = jobState(job);
  if (state === "scheduled") return "计划中";
  if (state === "paused") return "暂停";
  if (state === "running") return "执行中";
  if (state === "completed") return "已完成";
  if (state === "error") return "错误";
  return job.enabled ? "启用" : "暂停";
}

function statusTone(job: CronJob): "ok" | "warn" | "err" | "neutral" | "live" {
  const state = jobState(job);
  if (state === "running") return "live";
  if (state === "scheduled") return "ok";
  if (state === "paused") return "warn";
  if (state === "error") return "err";
  return "neutral";
}

function runTone(status: CronRun["status"]): "ok" | "warn" | "err" | "neutral" | "live" {
  if (status === "success") return "ok";
  if (status === "error" || status === "blocked") return "err";
  if (status === "silent") return "warn";
  return "neutral";
}

function runStatusLabel(status: CronRun["status"]): string {
  if (status === "success") return "成功";
  if (status === "error") return "失败";
  if (status === "blocked") return "阻断";
  if (status === "silent") return "静默";
  return "未知";
}

function jobKey(job: CronJob): string {
  return `${cronJobProfile(job)}:${job.id}`;
}

function parseTime(value: string | number | null | undefined): Date | null {
  if (value == null) return null;
  const date = typeof value === "number"
    ? new Date(value < 1_000_000_000_000 ? value * 1000 : value)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value: string | number | null | undefined): string {
  const date = parseTime(value);
  if (!date) return "—";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatFullTime(value: string | number | null | undefined): string {
  const date = parseTime(value);
  if (!date) return "—";
  return date.toLocaleString("zh-CN");
}

function relativeTime(value: string | number | null | undefined): string {
  const date = parseTime(value);
  if (!date) return "—";
  const diffMs = Date.now() - date.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return future ? "即将" : "刚刚";
  if (mins < 60) return future ? `${mins} 分后` : `${mins} 分前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return future ? `${hours} 小时后` : `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return future ? `${days} 天后` : `${days} 天前`;
  const weeks = Math.round(days / 7);
  return future ? `${weeks} 周后` : `${weeks} 周前`;
}

function resultLine(job: CronJob): string {
  const status = text(job.last_status);
  if (!status) return "尚无执行结果";
  if (status === "ok") return "上次执行成功";
  if (status === "error") return `上次执行失败${text(job.last_error) ? `：${text(job.last_error)}` : ""}`;
  return `上次执行：${status}`;
}

function actionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "请求失败");
}

function matchesStatus(job: CronJob, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  const state = jobState(job);
  if (filter === "active") return job.enabled && state !== "paused" && state !== "completed" && state !== "error";
  if (filter === "paused") return isPaused(job);
  if (filter === "error") return state === "error" || text(job.last_status) === "error";
  return state === "completed";
}

function buildRunErrorMessage(error: unknown): string {
  const raw = actionError(error);
  if (raw.includes("HTTP 404") || raw.includes("__hermes_cron_runs")) {
    return "当前环境无法读取本地运行历史，请使用桌面端打开。";
  }
  return `加载运行历史失败：${raw}`;
}

function editorInitialValues(editor: EditorState, activeProfile: string): CronEditorValues {
  if (!editor || editor.mode === "create") {
    return {
      profile: activeProfile || "default",
      name: "",
      prompt: "",
      schedule: DEFAULT_SCHEDULE_EXPR,
      deliver: "local",
      model: "",
      enabled: true,
    };
  }
  const job = editor.job;
  return {
    profile: cronJobProfile(job),
    name: text(job.name),
    prompt: text(job.prompt),
    schedule: jobScheduleExpr(job) || text(job.schedule_display) || DEFAULT_SCHEDULE_EXPR,
    deliver: text(job.deliver) || "local",
    model: jobModel(job),
    enabled: !isPaused(job),
  };
}

export function CronRoute() {
  const jobsQuery = useCronJobs();
  const profilesQuery = useProfiles();
  const activeProfile = useActiveProfileName();
  const createJob = useCreateCronJob();
  const updateJob = useUpdateCronJob();
  const deleteJob = useDeleteCronJob();
  const cronAction = useCronAction();
  const deliveryTargetsQuery = useCronDeliveryTargets(activeProfile);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { confirm } = useConfirm();

  const [query, setQuery] = useState("");
  const [profileFilter, setProfileFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedRunFilename, setSelectedRunFilename] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingTrigger, setPendingTrigger] = useState<PendingTrigger | null>(null);
  const refreshTimersRef = useRef<number[]>([]);

  const jobs = jobsQuery.data ?? [];
  const profiles = profilesQuery.data ?? [];
  const deliveryTargets = deliveryTargetsQuery.data ?? [];
  const deliveryTargetsUnavailable = deliveryTargetsQuery.isError || deliveryTargets.length === 0;
  const effectiveDeliveryTargets = deliveryTargetsUnavailable
    ? FALLBACK_DELIVERY_TARGETS
    : deliveryTargets;

  const filteredJobs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const profile = cronJobProfile(job);
      if (profileFilter !== "all" && profile !== profileFilter) return false;
      if (!matchesStatus(job, statusFilter)) return false;
      if (!needle) return true;
      return [titleOf(job), promptPreview(job), scheduleDisplay(job), profile, job.id]
        .join("\n")
        .toLowerCase()
        .includes(needle);
    });
  }, [jobs, profileFilter, query, statusFilter]);

  useEffect(() => {
    if (filteredJobs.length === 0) {
      if (!jobsQuery.isFetching) setSelectedKey(null);
      return;
    }
    if (!selectedKey) {
      setSelectedKey(jobKey(filteredJobs[0]));
      return;
    }
    if (!filteredJobs.some((job) => jobKey(job) === selectedKey) && !jobsQuery.isFetching) {
      setSelectedKey(jobKey(filteredJobs[0]));
    }
  }, [filteredJobs, jobsQuery.isFetching, selectedKey]);

  const selectedJob = useMemo(() => {
    if (!selectedKey) return null;
    return filteredJobs.find((job) => jobKey(job) === selectedKey) ?? null;
  }, [filteredJobs, selectedKey]);

  const runsQuery = useCronRuns(selectedJob, 30);
  const runs = runsQuery.data ?? [];
  const runSessionsQuery = useCronRunSessions(selectedJob, 30);
  const runSessions = runSessionsQuery.data ?? [];
  const runsRef = useRef<CronRun[]>(runs);
  runsRef.current = runs;

  useEffect(() => {
    setSelectedRunFilename(null);
  }, [selectedJob?.id, selectedJob ? cronJobProfile(selectedJob) : ""]);

  useEffect(() => {
    if (runs.length === 0) {
      setSelectedRunFilename(null);
      return;
    }
    if (!selectedRunFilename || !runs.some((run) => run.filename === selectedRunFilename)) {
      setSelectedRunFilename(runs[0]?.filename ?? null);
    }
  }, [runs, selectedRunFilename]);

  const selectedRun = useMemo(() => {
    if (!selectedRunFilename) return runs[0] ?? null;
    return runs.find((run) => run.filename === selectedRunFilename) ?? runs[0] ?? null;
  }, [runs, selectedRunFilename]);
  const runDetailQuery = useCronRunDetail(selectedRun);

  const clearQueuedRefreshes = useCallback(() => {
    refreshTimersRef.current.forEach((id) => window.clearTimeout(id));
    refreshTimersRef.current = [];
  }, []);

  const refetchCronData = useCallback(() => {
    void jobsQuery.refetch();
    void runsQuery.refetch();
    void runSessionsQuery.refetch();
  }, [jobsQuery, runsQuery, runSessionsQuery]);

  const pollRef = useRef({
    jobs: jobsQuery.refetch,
    runs: runsQuery.refetch,
    sessions: runSessionsQuery.refetch,
  });
  pollRef.current = {
    jobs: jobsQuery.refetch,
    runs: runsQuery.refetch,
    sessions: runSessionsQuery.refetch,
  };

  const queueFollowUpRefreshes = useCallback((job: CronJob) => {
    clearQueuedRefreshes();
    const profile = cronJobProfile(job);
    refreshTimersRef.current = [2_000, 8_000, 30_000, 65_000].map((delay) =>
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["cron-jobs"] });
        void queryClient.invalidateQueries({ queryKey: ["cron-runs", profile, job.id] });
        void queryClient.invalidateQueries({ queryKey: ["cron-run-sessions", profile, job.id] });
      }, delay),
    );
  }, [clearQueuedRefreshes, queryClient]);

  useEffect(() => clearQueuedRefreshes, [clearQueuedRefreshes]);

  useEffect(() => {
    if (!pendingTrigger) return;
    let stopped = false;

    const step = () => {
      if (stopped) return;
      const watching = selectedJob !== null && jobKey(selectedJob) === pendingTrigger.key;
      if (watching && pendingRunSettled(runsRef.current, pendingTrigger.requestedAt)) {
        setPendingTrigger(null);
        setFeedback({ tone: "info", message: "运行已落地，运行历史已刷新。" });
        return;
      }
      if (pendingRunExpired(pendingTrigger.requestedAt)) {
        setPendingTrigger(null);
        setFeedback({
          tone: "error",
          message: "已等待 90 秒仍未出现运行记录：调度器可能已暂停或本轮 tick 未生效，请确认任务状态后重试。",
        });
        return;
      }
      if (watching) {
        void pollRef.current.jobs();
        void pollRef.current.runs();
        void pollRef.current.sessions();
      }
    };

    step();
    const timer = window.setInterval(step, 3_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pendingTrigger, selectedJob]);

  const editorValues = editorInitialValues(editor, activeProfile);
  const editorKey = editor
    ? `${editor.mode}:${editor.mode === "edit" ? jobKey(editor.job) : "new"}`
    : "closed";

  const openCreate = () => {
    setEditorError(null);
    setEditor({ mode: "create" });
  };

  const openEdit = (job: CronJob) => {
    setEditorError(null);
    setEditor({ mode: "edit", job });
  };

  const closeEditor = () => {
    setEditor(null);
    setEditorError(null);
  };

  const handleCreate = (values: CronEditorValues) => {
    setEditorError(null);
    createJob.mutate(
      { ...createPayload(values), profile: values.profile || "default" },
      {
        onSuccess: (job) => {
          closeEditor();
          setProfileFilter("all");
          setSelectedKey(jobKey(job));
          setFeedback({ tone: "ok", message: `已创建定时任务「${titleOf(job)}」。` });
        },
        onError: (err) => setEditorError(backendErrorMessage(err)),
      },
    );
  };

  const handleUpdate = (values: CronEditorValues, job: CronJob) => {
    if (!editor || editor.mode !== "edit") return;
    setEditorError(null);
    const action = enabledAction(values, { enabled: !isPaused(job) });
    updateJob.mutate(
      {
        id: job.id,
        profile: cronJobProfile(job),
        updates: updatePayload(values),
      },
      {
        onSuccess: (updated) => {
          if (action) {
            cronAction.mutate(
              { id: job.id, profile: cronJobProfile(job), action },
              {
                onError: (err) => setFeedback({
                  tone: "error",
                  message: `配置已保存，但${action === "pause" ? "暂停" : "恢复"}失败：${backendErrorMessage(err)}`,
                }),
              },
            );
          }
          closeEditor();
          setSelectedKey(jobKey(updated));
          setFeedback({ tone: "ok", message: `已保存「${titleOf(updated)}」的修改。` });
        },
        onError: (err) => setEditorError(backendErrorMessage(err)),
      },
    );
  };

  const handleAction = (job: CronJob, action: "pause" | "resume" | "trigger") => {
    cronAction.mutate(
      { id: job.id, profile: cronJobProfile(job), action },
      {
        onSuccess: (updated) => {
          setSelectedKey(jobKey(updated));
          if (action === "trigger") {
            setPendingTrigger({ key: jobKey(updated), requestedAt: Date.now() });
            setFeedback({
              tone: "info",
              message: `已触发「${titleOf(updated)}」，正在排队等待调度器执行。`,
            });
            queueFollowUpRefreshes(updated);
            return;
          }
          setFeedback({ tone: "ok", message: `${action === "pause" ? "已暂停" : "已恢复"}「${titleOf(updated)}」。` });
        },
        onError: (err) => {
          const actionLabel = action === "pause" ? "暂停" : action === "resume" ? "恢复" : "触发";
          setFeedback({ tone: "error", message: `${actionLabel}定时任务失败：${backendErrorMessage(err)}` });
        },
      },
    );
  };

  const handleDelete = async (job: CronJob) => {
    const confirmed = await confirm({
      title: "删除定时任务",
      body: `删除定时任务「${titleOf(job)}」？此操作无法撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!confirmed) return;
    deleteJob.mutate(
      { id: job.id, profile: cronJobProfile(job) },
      {
        onSuccess: () => {
          setPendingTrigger(null);
          setFeedback({ tone: "ok", message: `已删除定时任务「${titleOf(job)}」。` });
          setSelectedKey(null);
        },
        onError: (err) => setFeedback({ tone: "error", message: `删除定时任务失败：${backendErrorMessage(err)}` }),
      },
    );
  };

  const openRun = (run: CronRun) => {
    const sessionId = sessionIdForRun(runStartedMs(run), runSessions);
    if (sessionId) {
      navigate(`/tasks/${encodeURIComponent(sessionId)}`);
      return;
    }
    setSelectedRunFilename(run.filename);
  };

  const headerRight = (
    <div className={s.headerActions}>
      <button type="button" className={s.headerButton} onClick={refetchCronData} disabled={jobsQuery.isFetching || runsQuery.isFetching}>
        <RefreshCw size={12} /> 刷新
      </button>
      <button type="button" className={s.headerPrimary} onClick={openCreate}>
        <Plus size={12} /> 新建任务
      </button>
    </div>
  );

  const activeCount = jobs.filter((job) => matchesStatus(job, "active")).length;
  const errorCount = jobs.filter((job) => matchesStatus(job, "error")).length;
  const pendingForSelected = pendingTrigger && selectedJob && pendingTrigger.key === jobKey(selectedJob)
    ? pendingTrigger
    : null;

  return (
    <SectionShell title="定时任务" sub={`${jobs.length} 个任务 · ${activeCount} 个活跃${errorCount ? ` · ${errorCount} 个异常` : ""}`} right={headerRight}>
      <div className={s.pageGrid}>
        <aside className={s.listPane} aria-label="定时任务列表">
          <div className={s.searchBox}>
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、Prompt、Profile…" />
          </div>
          <div className={s.filters}>
            <select value={profileFilter} onChange={(event) => setProfileFilter(event.target.value)} aria-label="Profile 筛选">
              <option value="all">全部 Profile</option>
              {profiles.map((profile) => (
                <option key={profile.name} value={profile.name}>{profile.name === "default" ? "default" : profile.name}</option>
              ))}
            </select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} aria-label="状态筛选">
              {STATUS_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>

          {jobsQuery.isLoading ? <LoadingState variant="block" label="正在加载定时任务…" /> : null}
          {jobsQuery.isError ? (
            <div className={s.errorState}>加载定时任务失败：{actionError(jobsQuery.error)}</div>
          ) : null}
          {!jobsQuery.isLoading && !jobsQuery.isError && filteredJobs.length === 0 ? (
            <div className={s.empty}>没有匹配的定时任务。</div>
          ) : null}

          <div className={s.jobList}>
            {filteredJobs.map((job) => {
              const selected = selectedJob ? jobKey(job) === jobKey(selectedJob) : false;
              return (
                <button
                  key={jobKey(job)}
                  type="button"
                  className={s.jobRow}
                  data-selected={selected ? "true" : undefined}
                  onClick={() => setSelectedKey(jobKey(job))}
                >
                  <span className={s.jobRowTop}>
                    <span className={s.jobTitle}>{titleOf(job)}</span>
                    <StatusDot tone={statusTone(job)} />
                  </span>
                  <span className={s.jobMeta}>{scheduleDisplay(job)}</span>
                  <span className={s.jobMeta}>{cronJobProfile(job)} · 上次 {relativeTime(job.last_run_at ?? job.last_run)}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className={s.detailPane} aria-label="定时任务详情">
          {feedback ? <div className={s.feedback} data-tone={feedback.tone}>{feedback.message}</div> : null}

          {editor ? (
            <CronJobEditor
              key={editorKey}
              mode={editor.mode}
              initial={editorValues}
              initialPreset={presetForExpr(editorValues.schedule).value}
              profiles={profiles.map((profile) => profile.name)}
              activeProfile={activeProfile || "default"}
              targets={effectiveDeliveryTargets}
              targetsUnavailable={deliveryTargetsUnavailable}
              saving={createJob.isPending || updateJob.isPending}
              saveError={editorError}
              onSubmit={(values) => {
                if (editor.mode === "edit") {
                  handleUpdate(values, editor.job);
                  return;
                }
                handleCreate(values);
              }}
              onCancel={closeEditor}
            />
          ) : selectedJob ? (
            <JobDetail
              job={selectedJob}
              busy={cronAction.isPending || deleteJob.isPending}
              onEdit={() => openEdit(selectedJob)}
              onPauseResume={() => handleAction(selectedJob, isPaused(selectedJob) ? "resume" : "pause")}
              onTrigger={() => handleAction(selectedJob, "trigger")}
              onDelete={() => handleDelete(selectedJob)}
            />
          ) : (
            <div className={s.detailEmpty}>
              <CalendarClock size={28} />
              <h2>选择或创建一个定时任务</h2>
              <p>这里会展示任务配置、Prompt 和最近执行状态。</p>
              <button type="button" className={s.primaryButton} onClick={openCreate}>新建任务</button>
            </div>
          )}
        </main>

        <aside className={s.historyPane} aria-label="运行历史记录">
          <div className={s.panelHeader}>
            <div>
              <div className={s.panelTitle}>运行历史记录</div>
              <div className={s.panelSub}>{selectedJob ? `${titleOf(selectedJob).slice(0, 28)} · 最近 30 次` : "选择任务后查看"}</div>
            </div>
            <Clock size={16} />
          </div>

          {!selectedJob ? <div className={s.empty}>尚未选择任务。</div> : null}
          {selectedJob && runsQuery.isLoading ? <LoadingState variant="block" label="正在加载运行历史…" /> : null}
          {selectedJob && runsQuery.isError ? (
            <div className={s.errorState}>{buildRunErrorMessage(runsQuery.error)}</div>
          ) : null}
          {selectedJob && !runsQuery.isLoading && !runsQuery.isError && runs.length === 0 && !pendingForSelected ? (
            <div className={s.empty}>尚无运行记录。立即运行一次后，记录会出现在这里。</div>
          ) : null}

          {pendingForSelected ? <PendingRunRow requestedAt={pendingForSelected.requestedAt} /> : null}

          <div className={s.runList}>
            {runs.map((run) => {
              const sessionId = sessionIdForRun(runStartedMs(run), runSessions);
              return (
                <div
                  key={run.filename}
                  className={s.runRow}
                  data-selected={selectedRun?.filename === run.filename ? "true" : undefined}
                >
                  <StatusDot tone={runTone(run.status)} />
                  <button
                    type="button"
                    className={s.runOpen}
                    onClick={() => openRun(run)}
                    title={sessionId ? "打开该次运行的会话" : "查看只读输出"}
                  >
                    <span className={s.runTitle}>{runStatusLabel(run.status)} · {run.summary}</span>
                    <span className={s.runMeta}>
                      {formatFullTime(run.started_at)} · {Math.ceil(run.size_bytes / 1024)} KB
                      {sessionId ? " · 可打开会话" : " · 仅输出"}
                    </span>
                  </button>
                  <span className={s.runAgo}>{relativeTime(run.started_at)}</span>
                  {sessionId ? (
                    <button
                      type="button"
                      className={s.runOutputButton}
                      onClick={() => setSelectedRunFilename(run.filename)}
                    >
                      输出
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>

          {selectedRun ? (
            <div className={s.runDetailBox}>
              <div className={s.runDetailHeader}>
                <span><FileText size={12} /> 输出详情</span>
                <span>{runStatusLabel(selectedRun.status)}</span>
              </div>
              {runDetailQuery.isLoading ? <LoadingState variant="block" label="正在读取输出…" /> : null}
              {runDetailQuery.isError ? <div className={s.errorState}>读取输出失败：{actionError(runDetailQuery.error)}</div> : null}
              {runDetailQuery.data ? (
                <>
                  {runDetailQuery.data.truncated ? <div className={s.truncated}>输出超过 2 MiB，已截断展示。</div> : null}
                  <pre className={s.outputPre}>{runDetailQuery.data.content || "（无输出内容）"}</pre>
                </>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>
    </SectionShell>
  );
}

interface JobDetailProps {
  job: CronJob;
  busy: boolean;
  onEdit: () => void;
  onPauseResume: () => void;
  onTrigger: () => void;
  onDelete: () => void;
}

function JobDetail({ job, busy, onEdit, onPauseResume, onTrigger, onDelete }: JobDetailProps) {
  const paused = isPaused(job);
  const expr = jobScheduleExpr(job);
  return (
    <section className={s.card}>
      <div className={s.cardHeader}>
        <div className={s.cardHeaderTop}>
          <div className={s.breadcrumb}>自动化功能 / {cronJobProfile(job)}</div>
          <div className={s.detailActions}>
            <span className={s.statusBadge} data-tone={statusTone(job)}>{statusLabel(job)}</span>
            <button type="button" className={s.secondaryButton} onClick={onEdit} disabled={busy}><Pencil size={16} /> 编辑</button>
            <button type="button" className={s.secondaryButton} onClick={onPauseResume} disabled={busy}>
              {paused ? <Play size={16} /> : <Pause size={16} />}{paused ? "恢复" : "暂停"}
            </button>
            <button type="button" className={s.primaryButton} onClick={onTrigger} disabled={busy}><Zap size={16} /> 立即运行</button>
            <button type="button" className={s.dangerButton} onClick={onDelete} disabled={busy}><Trash2 size={16} /> 删除</button>
          </div>
        </div>
        <div className={s.titleBlock}>
          <h1>{titleOf(job)}</h1>
          <p>{promptPreview(job).slice(0, 180)}</p>
        </div>
      </div>

      <div className={s.statsGrid}>
        <InfoTile icon={<CalendarClock size={16} />} label="调度" value={scheduleDisplay(job)} />
        <InfoTile icon={<Clock size={16} />} label="下次运行" value={formatTime(job.next_run_at ?? job.next_run)} />
        <InfoTile icon={<CheckCircle2 size={16} />} label="上次运行" value={formatTime(job.last_run_at ?? job.last_run)} />
        <InfoTile icon={<AlertCircle size={16} />} label="上次结果" value={resultLine(job)} tone={text(job.last_status) === "error" ? "err" : "neutral"} />
      </div>

      <div className={s.detailGrid}>
        <div className={s.detailItem}>
          <span>调度表达式</span>
          <strong>{expr || "未设置"}</strong>
        </div>
        <div className={s.detailItem}>
          <span>Profile</span>
          <strong>{cronJobProfile(job)}</strong>
        </div>
        <div className={s.detailItem}>
          <span>投递目标</span>
          <strong>{deliverySummary(text(job.deliver))}</strong>
        </div>
        <div className={s.detailItem}>
          <span>模型</span>
          <strong>{jobModel(job) || "默认模型"}</strong>
        </div>
      </div>

      {text(job.last_error) ? <div className={s.lastError}>{job.last_error}</div> : null}

      <section className={s.promptCard}>
        <div className={s.promptHeader}>Prompt · {job.id}</div>
        <pre>{text(job.prompt) || text(job.script) || "（无任务描述）"}</pre>
      </section>
    </section>
  );
}

function InfoTile({ icon, label, value, tone = "neutral" }: { icon: React.ReactNode; label: string; value: string; tone?: "neutral" | "err" }) {
  return (
    <div className={s.infoTile} data-tone={tone}>
      <span className={s.infoIcon}>{icon}</span>
      <span className={s.infoText}>
        <span>{label}</span>
        <strong>{value}</strong>
      </span>
    </div>
  );
}
