import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  type CSSProperties,
} from "react";
import {
  useAtom,
  useAtomValue,
} from "jotai";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Bug,
  ExternalLink as ExternalLinkIcon,
  GitFork,
  Heart,
  Image as ImageIcon,
  RefreshCw,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import {
  Alert,
  Button,
  Dialog,
  Field,
  Input,
  LoadingState,
  Select,
  StatusDot,
  useTheme,
  type ThemeConfig,
} from "@hermes/shared-ui";
import {
  useConfig,
  useConfigSchema,
  useSaveConfig,
} from "@/hooks/use-config";
import {
  useSkills,
  useToggleSkill,
} from "@/hooks/use-skills";
import {
  cronJobProfile,
  useCronJobs,
  useCreateCronJob,
  useDeleteCronJob,
  useCronAction,
} from "@/hooks/use-cron";
import { useLogs } from "@/hooks/use-logs";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  useYoloMode,
  useSetYoloMode,
  isYoloModeSupported,
} from "@/hooks/use-yolo-mode";
import {
  CONVERSATION_FONT_SIZE_OPTIONS,
  DEFAULT_ASSISTANT_DISPLAY_NAME,
  assistantAvatarDataUrlAtom,
  assistantDisplayNameAtom,
  composerSubmitShortcutAtom,
  conversationFontSizeAtom,
  type ConversationFontSizeMode,
  notifyOnApprovalAtom,
  notifyOnCompleteAtom,
  notifyOnlyBackgroundAtom,
  notifySoundAtom,
  notifySystemAtom,
  profileSwitchingAtom,
  showReasoningAtom,
  telemetryEnabledAtom,
  normalizeAssistantDisplayName,
} from "@/stores/ui";
import {
  playChime,
  shouldPlayFallbackSound,
} from "@/lib/notifications";
import { openExternalUrl } from "@/lib/external-links";
import {
  detectHostOS,
  runtime,
} from "@/lib/runtime";
import {
  checkDesktopUpdate,
  DESKTOP_UPDATE_DOWNLOAD_URL,
} from "@/lib/desktop-update";
import { versionLabel } from "@/lib/build-info";
import {
  approvalModeConfigValue,
  approvalModeLabel,
  isApprovalModeAvailable,
  normalizeApprovalMode,
  type ApprovalMode,
} from "@/lib/approval-mode";
import {
  buildNestedConfigUpdate,
  mergeConfigUpdate,
} from "@/lib/config-update";
import {
  translateConfigField,
  translateConfigOption,
} from "@/lib/config-translations";
import type { ComposerSubmitShortcut } from "@/lib/composer-submit-shortcut";
import type {
  ConfigSchemaField,
  CronJob,
  DesktopUpdateCheckResult,
} from "@hermes/protocol";
import { CopyButton } from "@/components/ui/copy-button";
import { WandermindsMark } from "@/components/brand/wanderminds-mark";
import s from "./settings.module.css";

/* ── General ─────────────────────────────────────────────────────────── */

interface SettingsSectionProps {
  showHeading?: boolean;
}

export function GeneralSection({ showHeading = true }: SettingsSectionProps) {
  const [showReasoning, setShowReasoning] = useAtom(showReasoningAtom);
  const [telemetryEnabled, setTelemetryEnabled] = useAtom(telemetryEnabledAtom);
  const [composerSubmitShortcut, setComposerSubmitShortcut] = useAtom(composerSubmitShortcutAtom);
  const [assistantDisplayName, setAssistantDisplayName] = useAtom(assistantDisplayNameAtom);
  const [assistantAvatarDataUrl, setAssistantAvatarDataUrl] = useAtom(assistantAvatarDataUrlAtom);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [assistantProfileError, setAssistantProfileError] = useState("");

  const handleAssistantNameChange = (value: string) => {
    setAssistantProfileError("");
    setAssistantDisplayName(value);
  };

  const handleAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    setAssistantProfileError("");
    if (!file.type.startsWith("image/")) {
      setAssistantProfileError("请选择 PNG、JPG、WebP、GIF 或 SVG 图片。");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setAssistantProfileError("头像图片不能超过 2 MB。");
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("读取头像失败"));
        reader.readAsDataURL(file);
      });
      if (!dataUrl.startsWith("data:image/")) {
        setAssistantProfileError("头像文件格式不受支持。");
        return;
      }
      setAssistantAvatarDataUrl(dataUrl);
    } catch (error) {
      setAssistantProfileError(error instanceof Error ? error.message : "读取头像失败");
    } finally {
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  };

  return (
    <div>
      {showHeading && <h2 className={s.heading}>常规</h2>}
      <Row label="显示推理过程" sub="在会话中展示模型的思考和推理内容" right={
        <RadioGroup value={showReasoning ? "on" : "off"} options={[{ value: "off", label: "隐藏" }, { value: "on", label: "显示" }]} onChange={(v) => setShowReasoning(v === "on")} />
      } />
      <Row label="发送快捷键" sub="控制对话输入框的提交方式；未触发发送的 Enter 会保留为换行。" right={
        <RadioGroup value={composerSubmitShortcut} options={[{ value: "enter", label: "Enter 发送" }, { value: "ctrl-enter", label: "Ctrl+Enter 发送" }]} onChange={(v) => setComposerSubmitShortcut(v as ComposerSubmitShortcut)} />
      } />
      <Row label="Hermes 名称" sub="显示在对话中助手消息上方的名称，留空恢复为 Hermes。" right={
        <div className={s.assistantProfileControl}>
          <input
            className={s.assistantNameInput}
            value={assistantDisplayName === DEFAULT_ASSISTANT_DISPLAY_NAME ? "" : assistantDisplayName}
            placeholder={DEFAULT_ASSISTANT_DISPLAY_NAME}
            maxLength={40}
            onChange={(event) => handleAssistantNameChange(event.target.value)}
            onBlur={(event) => setAssistantDisplayName(normalizeAssistantDisplayName(event.target.value))}
          />
          {assistantDisplayName !== DEFAULT_ASSISTANT_DISPLAY_NAME ? (
            <button
              type="button"
              className={s.iconPlainButton}
              onClick={() => handleAssistantNameChange("")}
              title="恢复默认名称"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      } />
      <Row label="Hermes 头像" sub="上传后会显示在 Hermes 的对话消息旁；不设置时保持原有纯文本样式。" right={
        <div className={s.assistantAvatarControl}>
          <input
            ref={avatarInputRef}
            className={s.hiddenFileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            onChange={(event) => void handleAvatarFile(event.target.files?.[0])}
          />
          {assistantAvatarDataUrl ? (
            <img className={s.assistantAvatarPreview} src={assistantAvatarDataUrl} alt="Hermes 头像预览" />
          ) : (
            <span className={s.assistantAvatarPlaceholder}><ImageIcon size={16} /></span>
          )}
          <button type="button" className={s.btn} onClick={() => avatarInputRef.current?.click()}>
            <Upload size={12} /> 上传
          </button>
          {assistantAvatarDataUrl ? (
            <button type="button" className={s.btn} onClick={() => { setAssistantProfileError(""); setAssistantAvatarDataUrl(""); }}>
              移除
            </button>
          ) : null}
        </div>
      } />
      {assistantProfileError ? <p className={s.assistantProfileError}>{assistantProfileError}</p> : null}
      <p className={s.assistantProfileStorageHint}>名称和头像只改变桌面端显示，不影响模型本身。清空名称、移除头像后即可恢复默认样式。</p>
      <Row label="匿名使用统计" sub="上报版本号、系统类型、语言等匿名信息帮助改进产品；不含对话内容、密钥或任何可识别个人的信息。" right={
        <RadioGroup value={telemetryEnabled ? "on" : "off"} options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} onChange={(v) => setTelemetryEnabled(v === "on")} />
      } />
      <ApprovalModeSection />
    </div>
  );
}

/* ── Notifications ───────────────────────────────────────────────────── */

type NotifyTestState =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "ok"; message: string }
  | { phase: "error"; message: string };

export function NotificationSection({ showHeading = true }: SettingsSectionProps) {
  const [notifySystem, setNotifySystem] = useAtom(notifySystemAtom);
  const [notifySound, setNotifySound] = useAtom(notifySoundAtom);
  const [notifyOnComplete, setNotifyOnComplete] = useAtom(notifyOnCompleteAtom);
  const [notifyOnApproval, setNotifyOnApproval] = useAtom(notifyOnApprovalAtom);
  const [notifyOnlyBackground, setNotifyOnlyBackground] = useAtom(notifyOnlyBackgroundAtom);
  const [testState, setTestState] = useState<NotifyTestState>({ phase: "idle" });

  const allChannelsOff = !notifySystem && !notifySound;
  const toggleOptions = [{ value: "off", label: "关闭" }, { value: "on", label: "开启" }];

  const handleTestNotification = async () => {
    const bridge = window.hermesDesktop;
    if (typeof bridge?.desktopNotify !== "function") {
      setTestState({ phase: "error", message: "当前为 Web 模式，系统通知仅桌面端支持" });
      return;
    }
    setTestState({ phase: "sending" });
    try {
      const result = await bridge.desktopNotify({
        kind: "test",
        title: "Hermes 通知测试",
        body: "看到这条系统通知说明配置正常（macOS 首次会请求授权）。",
        showSystemNotification: notifySystem,
        withSound: notifySound,
        respectFocus: false,
        requestAttention: false,
      });
      // 复用真实链路的兜底判定，让用户能预听系统通知关闭时的提示音。
      const previewSettings = {
        system: notifySystem,
        sound: notifySound,
        onComplete: true,
        onApproval: true,
        onlyBackground: false,
      };
      if (shouldPlayFallbackSound(previewSettings, result)) playChime();
      if (result.error) {
        setTestState({
          phase: "error",
          message: `系统通知发送失败：${result.error}（请检查系统设置中的通知权限）`,
        });
      } else if (notifySystem && result.delivered) {
        setTestState({ phase: "ok", message: "已发送，请查看系统通知" });
      } else if (notifySound) {
        setTestState({ phase: "ok", message: "已播放提示音（系统通知未开启）" });
      } else {
        setTestState({ phase: "ok", message: "系统通知与提示音均未开启，本次测试没有任何提醒" });
      }
    } catch (err) {
      setTestState({
        phase: "error",
        message: `测试失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const testSub =
    testState.phase === "ok" || testState.phase === "error"
      ? testState.message
      : "验证系统通知权限是否已授予（窗口在前台也会发送）";

  return (
    <div>
      {showHeading && <h2 className={s.heading}>通知</h2>}
      <Row label="系统通知" sub="任务需要关注时通过 macOS 通知中心 / Windows 通知横幅提醒" right={
        <RadioGroup value={notifySystem ? "on" : "off"} options={toggleOptions} onChange={(v) => setNotifySystem(v === "on")} />
      } />
      <Row label="提示音" sub="提醒时播放声音；系统通知开启时使用系统原生提示音" right={
        <RadioGroup value={notifySound ? "on" : "off"} options={toggleOptions} onChange={(v) => setNotifySound(v === "on")} />
      } />
      <Row label="任务完成时通知" sub="回合结束（含任务出错）时提醒" right={
        <RadioGroup value={notifyOnComplete ? "on" : "off"} options={toggleOptions} onChange={(v) => setNotifyOnComplete(v === "on")} />
      } />
      <Row label="需要权限确认时通知" sub="任务等待你批准命令时提醒，并请求任务栏 / Dock 注意" right={
        <RadioGroup value={notifyOnApproval ? "on" : "off"} options={toggleOptions} onChange={(v) => setNotifyOnApproval(v === "on")} />
      } />
      <Row label="仅窗口在后台时通知" sub="窗口在前台时不打扰；关闭后前台也会提醒" right={
        <RadioGroup value={notifyOnlyBackground ? "on" : "off"} options={toggleOptions} onChange={(v) => setNotifyOnlyBackground(v === "on")} />
      } />
      {allChannelsOff && (
        <p className={s.desc}>系统通知与提示音均已关闭，上方事件开关暂不生效。</p>
      )}
      <Row label="发送测试通知" sub={testSub} right={
        <Button
          type="button"
          variant="outline"
          loading={testState.phase === "sending"}
          onClick={() => void handleTestNotification()}
        >
          测试
        </Button>
      } />
    </div>
  );
}

const UI_SCALE_OPTIONS: Array<{ value: ThemeConfig["scale"]; label: string }> = [
  { value: "sm", label: "90%" },
  { value: "md", label: "100%" },
  { value: "lg", label: "110%" },
  { value: "xl", label: "125%" },
  { value: "2xl", label: "150%" },
];

export function ThemeSection({ showHeading = true }: SettingsSectionProps) {
  const { config, update } = useTheme();
  const [conversationFontSize, setConversationFontSize] = useAtom(conversationFontSizeAtom);
  const densityLabel = config.density === "compact" ? "紧凑" : "舒适";

  return (
    <div>
      {showHeading && <h2 className={s.heading}>主题</h2>}
      <div className={s.appearancePanel}>
        <div className={s.appearanceHeader}>
          <div className={s.appearanceHeaderText}>
            <h3>界面外观</h3>
            <p>默认社区主题采用中性黑白灰，同时保留兼容主题。</p>
          </div>
          <span className={s.appearanceMeta}>实时生效 · {densityLabel}</span>
        </div>

        <AppearanceRow
          label="主题"
          sub="社区浅色与社区深色遵循同一套扁平设计令牌，其他主题作为兼容选项保留。"
          right={
            <ThemeSkinPicker
              value={config.theme}
              onChange={(theme) => update({ theme })}
            />
          }
        />
        <AppearanceRow
          label="界面缩放"
          sub="整体放大或缩小界面（文字、间距、图标一起缩放），适配高分屏 / 4K 显示器。标准为 100%。"
          right={
            <RadioGroup value={config.scale} options={UI_SCALE_OPTIONS} onChange={(v) => update({ scale: v as ThemeConfig["scale"] })} />
          }
        />
        <AppearanceRow
          label="密度"
          sub="调整行与卡片的垂直留白。舒适匹配当前默认布局。"
          right={
            <RadioGroup value={config.density} options={[{ value: "compact", label: "紧凑" }, { value: "comfortable", label: "舒适" }]} onChange={(v) => update({ density: v as ThemeConfig["density"] })} />
          }
        />
        <AppearanceRow
          label="对话字号"
          sub="只影响会话详情里的对话正文；代码块、工具日志和输入框保持原字号。"
          right={
            <RadioGroup
              value={conversationFontSize}
              options={CONVERSATION_FONT_SIZE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(v) => setConversationFontSize(v as ConversationFontSizeMode)}
            />
          }
        />
      </div>
    </div>
  );
}

const THEME_SKINS: Array<{
  value: ThemeConfig["theme"];
  label: string;
  sub: string;
  bg: string;
  pane: string;
  soft: string;
  text: string;
  accent: string;
}> = [
  {
    value: "light",
    label: "浅色",
    sub: "明亮柔和",
    bg: "#fbfaf7",
    pane: "#ffffff",
    soft: "#f5f2ec",
    text: "#232120",
    accent: "#ff7a3d",
  },
  {
    value: "light-modern",
    label: "社区浅色",
    sub: "纸白与石墨",
    bg: "#f4f4f3",
    pane: "#ffffff",
    soft: "#ececeb",
    text: "#171716",
    accent: "#171716",
  },
  {
    value: "dark",
    label: "经典深色",
    sub: "暖墨颗粒",
    bg: "#0a0908",
    pane: "#11100e",
    soft: "#232120",
    text: "#faf7f0",
    accent: "#ff7a3d",
  },
  {
    value: "dark-modern",
    label: "社区深色",
    sub: "炭黑与暖白",
    bg: "#111111",
    pane: "#181818",
    soft: "#2a2a2a",
    text: "#f1f1ef",
    accent: "#f1f1ef",
  },
  {
    value: "dracula",
    label: "Dracula",
    sub: "紫粉高对比",
    bg: "#282a36",
    pane: "#44475a",
    soft: "#21222c",
    text: "#f8f8f2",
    accent: "#bd93f9",
  },
  {
    value: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    sub: "柔和蓝灰",
    bg: "#1e1e2e",
    pane: "#181825",
    soft: "#313244",
    text: "#cdd6f4",
    accent: "#cba6f7",
  },
];

function AppearanceRow({
  label,
  sub,
  right,
  meta,
}: {
  label: string;
  sub: string;
  right: React.ReactNode;
  meta?: string;
}) {
  return (
    <div className={s.appearanceRow}>
      <div className={s.appearanceRowText}>
        <div className={s.appearanceRowLabel}>{label}</div>
        <div className={s.appearanceRowSub}>{sub}</div>
      </div>
      <div className={s.appearanceRowControl}>{right}</div>
      {meta ? <div className={s.appearanceRowMeta}>{meta}</div> : null}
    </div>
  );
}

function ThemeSkinPicker({
  value,
  onChange,
}: {
  value: ThemeConfig["theme"];
  onChange: (theme: ThemeConfig["theme"]) => void;
}) {
  return (
    <div className={s.skinPicker} role="radiogroup" aria-label="主题皮肤">
      {THEME_SKINS.map((skin) => {
        const active = skin.value === value;
        const style = {
          "--skin-bg": skin.bg,
          "--skin-pane": skin.pane,
          "--skin-soft": skin.soft,
          "--skin-text": skin.text,
          "--skin-accent": skin.accent,
        } as CSSProperties;
        return (
          <button
            key={skin.value}
            type="button"
            className={s.skinCard}
            style={style}
            role="radio"
            aria-checked={active}
            data-active={active ? "true" : undefined}
            onClick={() => onChange(skin.value)}
          >
            <span className={s.skinPreview} aria-hidden="true">
              <span className={s.skinPreviewTop} />
              <span className={s.skinPreviewBody}>
                <span />
                <span />
                <span />
              </span>
              <span className={s.skinPreviewAccent} />
            </span>
            <span className={s.skinCopy}>
              <span className={s.skinTitle}>{skin.label}</span>
              <span className={s.skinSub}>{skin.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Approval mode ───────────────────────────────────────────────────── */

const APPROVAL_MODE_DESC: Record<ApprovalMode, string> = {
  default: "遇到有风险的命令会请你手动确认，适合大多数情况的默认安全策略。",
  smart: "先由辅助模型判断风险：低风险自动放行，高风险自动拒绝，不确定时再请你手动决定。",
  yolo: "自动批准所有有风险的命令。请仅在受信任或隔离的环境中使用。",
};

function ApprovalModeSection() {
  const navigate = useNavigate();
  const { data: config } = useConfig();
  const { data: schema } = useConfigSchema();
  const saveConfig = useSaveConfig();
  const { data: yolo } = useYoloMode();
  const setYolo = useSetYoloMode();
  const restartInFlight = useAtomValue(profileSwitchingAtom).active;
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pendingMode, setPendingMode] = useState<ApprovalMode | null>(null);
  const [error, setError] = useState("");

  const approvalOptions = schema?.fields["approvals.mode"]?.options ?? [];
  const rawConfigMode = getNestedValue(config, "approvals.mode");
  const yoloEnabled = !!yolo?.enabled;
  const yoloEffective = !!yolo?.effective;
  const currentMode: ApprovalMode = yoloEnabled || yoloEffective ? "yolo" : normalizeApprovalMode(rawConfigMode);
  const yoloPending = yolo != null && yolo.enabled !== yolo.effective;
  const busy = saveConfig.isPending || setYolo.isPending || restartInFlight || pendingMode !== null;
  const smartAvailable = isApprovalModeAvailable("smart", approvalOptions, schema?.fields);
  const yoloAvailable = isYoloModeSupported() || isApprovalModeAvailable("yolo", approvalOptions);

  useEffect(() => {
    const focusFromHash = () => {
      if (window.location.hash !== "#approval-mode") return;
      window.requestAnimationFrame(() => {
        const el = sectionRef.current;
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus({ preventScroll: true });
      });
    };
    focusFromHash();
    window.addEventListener("hashchange", focusFromHash);
    return () => window.removeEventListener("hashchange", focusFromHash);
  }, []);

  const saveApprovalMode = async (mode: ApprovalMode) => {
    if (!config) throw new Error("配置尚未加载完成，请稍后再试");
    const nextValue = approvalModeConfigValue(mode, approvalOptions);
    const nextConfig = mergeConfigUpdate(config, buildNestedConfigUpdate("approvals.mode", nextValue));
    await saveConfig.mutateAsync(nextConfig);
  };

  const applyMode = async (mode: ApprovalMode) => {
    if (busy) return;
    if (mode === "smart" && !smartAvailable) {
      setError("当前版本暂不支持智能审批，请先更新 Hermes。");
      return;
    }
    if (mode === "yolo") {
      if (!yoloAvailable) {
        setError("当前环境不支持 YOLO 模式。");
        return;
      }
      setAcknowledged(false);
      setConfirmOpen(true);
      return;
    }

    setPendingMode(mode);
    setError("");
    try {
      await saveApprovalMode(mode);
      if ((yoloEnabled || yoloEffective) && isYoloModeSupported()) {
        await setYolo.mutateAsync(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err || "审批模式保存失败"));
    } finally {
      setPendingMode(null);
    }
  };

  const confirmEnableYolo = async () => {
    if (busy || !acknowledged) return;
    setConfirmOpen(false);
    setPendingMode("yolo");
    setError("");
    try {
      await saveApprovalMode("yolo");
      if (isYoloModeSupported()) {
        await setYolo.mutateAsync(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err || "YOLO 模式开启失败"));
    } finally {
      setPendingMode(null);
    }
  };

  const openSmartModelConfig = () => {
    navigate("/models#auxiliary-approval");
  };

  return (
    <section
      id="approval-mode"
      ref={sectionRef}
      className={s.approvalModePanel}
      tabIndex={-1}
      aria-labelledby="approval-mode-title"
    >
      <div className={s.approvalModeHead}>
        <ShieldCheck size={16} aria-hidden="true" />
        <div>
          <h3 id="approval-mode-title">危险命令审批模式</h3>
          <p>设置有风险命令的确认方式。改动只对之后的命令生效，已弹出的确认请求需单独处理。</p>
        </div>
      </div>

      <div className={s.approvalModeOptions} role="radiogroup" aria-label="危险命令审批模式">
        {(["default", "smart", "yolo"] as const).map((mode) => {
          const isCurrent = currentMode === mode;
          const isSaving = pendingMode === mode || (mode === "yolo" && setYolo.isPending);
          const disabled = busy ||
            (mode === "smart" && !smartAvailable) ||
            (mode === "yolo" && !yoloAvailable);
          return (
            <button
              key={mode}
              type="button"
              className={s.approvalModeOption}
              data-active={isCurrent ? "true" : undefined}
              data-danger={mode === "yolo" ? "true" : undefined}
              role="radio"
              aria-checked={isCurrent}
              disabled={disabled}
              onClick={() => void applyMode(mode)}
            >
              <span className={s.approvalModeOptionTitle}>
                {approvalModeLabel(mode)}
                {isCurrent && <span className={s.approvalModeBadge}>当前</span>}
                {isSaving && <span className={s.approvalModeBadge}>保存中…</span>}
              </span>
              <span className={s.approvalModeOptionDesc}>{APPROVAL_MODE_DESC[mode]}</span>
              {mode === "smart" && !smartAvailable && (
                <span className={s.approvalModeWarning}>当前版本暂不支持智能审批，请先更新 Hermes。</span>
              )}
              {mode === "yolo" && yoloPending && (
                <span className={s.approvalModeWarning}>YOLO 启动开关已保存，重启桌面端后生效。</span>
              )}
            </button>
          );
        })}
      </div>

      <div className={s.approvalModeFooter}>
        <Button type="button" variant="outline" onClick={openSmartModelConfig}>
          配置智能审批辅助模型
        </Button>
        <span>
          智能审批会用一个辅助模型来判断；未单独指定时，自动选择可用的辅助模型。
        </span>
      </div>

      {error && <div className={s.approvalModeError}>保存失败：{error}</div>}

      <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className={s.dangerDialog} aria-describedby="yolo-confirm-desc">
            <Dialog.Title className={s.dangerDialogTitle}>
              <AlertTriangle size={16} aria-hidden="true" />
              确认开启 YOLO 模式？
            </Dialog.Title>
            <Dialog.Description id="yolo-confirm-desc" className={s.dangerDialogBody}>
              开启后，Agent 执行 shell 命令、删除文件等高危操作时将<strong>不再弹出二次确认</strong>，
              全部自动批准。请确认你信任当前工作区、并清楚 Agent 将要做什么。切换会重启内核（约 5-15 秒）。
            </Dialog.Description>
            <label className={s.dangerConfirmRow}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              我已了解风险
            </label>
            <div className={s.dangerDialogActions}>
              <Dialog.Close asChild>
                <Button variant="outline">取消</Button>
              </Dialog.Close>
              <Button variant="outline" tone="danger" disabled={!acknowledged || busy} onClick={() => void confirmEnableYolo()}>
                确认开启
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

/* ── Config (Full Config Editor — maps to /api/config) ──────────────── */

const CATEGORY_CN: Record<string, string> = {
  general: "常规", agent: "Agent", terminal: "终端", display: "显示",
  delegation: "委派", memory: "记忆", compression: "压缩", security: "安全",
  browser: "浏览器", voice: "语音", tts: "TTS", stt: "STT",
  logging: "日志记录", discord: "Discord", auxiliary: "辅助",
};

export function ConfigSection({ showHeading = true }: SettingsSectionProps) {
  const { data: config } = useConfig();
  const { data: schema } = useConfigSchema();
  const saveConfig = useSaveConfig();
  const [activeCategory, setActiveCategory] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const categories = useMemo(() => {
    if (!schema) return [];
    return schema.category_order.length > 0
      ? schema.category_order
      : [...new Set(Object.values(schema.fields).map((f) => f.category))];
  }, [schema]);

  const categoryCounts = useMemo(() => {
    if (!schema) return {} as Record<string, number>;
    const counts: Record<string, number> = {};
    for (const f of Object.values(schema.fields)) {
      counts[f.category] = (counts[f.category] || 0) + 1;
    }
    return counts;
  }, [schema]);

  useEffect(() => {
    if (categories.length > 0 && !activeCategory) setActiveCategory(categories[0]);
  }, [categories, activeCategory]);

  if (!config || !schema) return <LoadingState variant="block" label="正在加载配置…" />;

  const isSearching = searchQuery.trim().length > 0;
  const lowerSearch = searchQuery.toLowerCase();

  const displayFields = isSearching
    ? Object.entries(schema.fields).filter(([key, f]) => {
        const label = key.split(".").pop()?.replace(/_/g, " ") ?? key;
        return key.toLowerCase().includes(lowerSearch)
          || label.toLowerCase().includes(lowerSearch)
          || f.description.toLowerCase().includes(lowerSearch)
          || translateConfigField(key, f.description).toLowerCase().includes(lowerSearch)
          || (CATEGORY_CN[f.category] ?? f.category).toLowerCase().includes(lowerSearch);
      })
    : Object.entries(schema.fields).filter(([, f]) => f.category === activeCategory);

  return (
    <div>
      {showHeading && <h2 className={s.heading}>配置</h2>}
      <p className={s.desc}>
        Hermes Agent 全部 {Object.keys(schema.fields).length} 个配置项，
        共 {categories.length} 个分类。修改后点击字段旁的"保存"按钮生效。
      </p>

      <div style={{ marginBottom: 12 }}>
        <Input placeholder="搜索配置项…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
      </div>

      {!isSearching && (
        <div className={s.configTabs} role="tablist" aria-label="配置分类">
          {categories.map((cat) => (
            <button
              key={cat}
              className={s.configTab}
              data-active={cat === activeCategory}
              role="tab"
              aria-selected={cat === activeCategory}
              onClick={() => setActiveCategory(cat)}
            >
              {CATEGORY_CN[cat] ?? cat}
              <span className={s.configTabCount}>{categoryCounts[cat] || 0}</span>
            </button>
          ))}
        </div>
      )}

      {isSearching && (
        <div className={s.modelsLabel}>搜索结果: {displayFields.length} 项</div>
      )}

      <div style={{ marginTop: 8 }}>
        {displayFields.map(([key, field]) => (
          <ConfigFieldRow
            key={key}
            fieldKey={key}
            field={field}
            value={getNestedValue(config, key)}
            onSave={(val) => saveConfig.mutate(mergeConfigUpdate(config, buildNestedConfigUpdate(key, val)))}
            showCategory={isSearching}
          />
        ))}
        {displayFields.length === 0 && (
          <div className={s.desc}>{isSearching ? `未找到匹配 "${searchQuery}" 的配置项。` : "此分类下暂无配置项。"}</div>
        )}
      </div>
    </div>
  );
}

/* ── Skills ───────────────────────────────────────────────────────────── */

export function SkillsSection() {
  const { data: skills, isLoading, isFetching, isError, error, refetch } = useSkills();
  const toggleSkill = useToggleSkill();
  const [filter, setFilter] = useState("");
  const refreshButton = (
    <Button variant="outline" type="button" onClick={() => void refetch()} loading={isFetching} leadingIcon={<RefreshCw size={12} />}>
      刷新
    </Button>
  );

  if (isLoading) return <LoadingState variant="block" label="正在加载技能…" />;
  if (isError) {
    const message = error instanceof Error ? error.message : "unknown error";
    return (
      <div>
        <div className={s.sectionTitleRow}>{refreshButton}</div>
        <p className={s.desc}>技能加载失败：{message}</p>
      </div>
    );
  }
  if (!skills) return null;

  const filtered = filter
    ? skills.filter((sk) => sk.name.includes(filter) || sk.description.includes(filter) || (sk.category ?? "").includes(filter))
    : skills;

  const grouped = groupBy(filtered, (sk) => sk.category ?? "other");

  return (
    <div>
      <div className={s.sectionTitleRow}>{refreshButton}</div>
      <p className={s.desc}>{skills.length} 个可用技能。启用/禁用后立即生效。</p>
      <div style={{ marginBottom: 16 }}>
        <Input placeholder="搜索技能…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {skills.length === 0 && <div className={s.desc}>未发现已安装技能。后端当前返回 0 项，请检查 Hermes home 的 skills 同步。</div>}
      {skills.length > 0 && filtered.length === 0 && <div className={s.desc}>没有匹配的技能。</div>}
      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} style={{ marginBottom: 16 }}>
          <div className={s.modelsLabel}>{category} ({items.length})</div>
          {items.map((sk) => (
            <div key={sk.name} className={s.row}>
              <div className={s.rowLeft}>
                <div className={s.rowLabel}>{sk.name}</div>
                <div className={s.rowSub}>{sk.description}</div>
              </div>
              <div className={s.rowRight}>
                <button className={s.toggle} data-on={sk.enabled} onClick={() => toggleSkill.mutate({ name: sk.name, enabled: !sk.enabled })}>
                  <span className={s.toggleThumb} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Cron Jobs ───────────────────────────────────────────────────────── */

function cronText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cronScheduleDisplay(job: CronJob): string {
  const schedule = job.schedule;
  if (cronText(job.schedule_display)) return cronText(job.schedule_display);
  if (typeof schedule === "string") return cronText(schedule) || "未设置";
  if (schedule && typeof schedule === "object") {
    return cronText(schedule.display) || cronText(schedule.expr) || cronText(schedule.value) || "未设置";
  }
  return "未设置";
}

function cronTitle(job: CronJob): string {
  return cronText(job.name) || cronText(job.prompt).slice(0, 60) || cronText(job.script).slice(0, 60) || job.id;
}

function cronPromptPreview(job: CronJob): string {
  return cronText(job.prompt) || (cronText(job.script) ? `脚本：${cronText(job.script)}` : "无任务描述");
}

function cronState(job: CronJob): string {
  return cronText(job.state) || (job.enabled ? "scheduled" : "paused");
}

function cronStateLabel(job: CronJob): string {
  const state = cronState(job);
  if (state === "scheduled") return "计划中";
  if (state === "paused") return "暂停";
  if (state === "running") return "执行中";
  if (state === "completed") return "已完成";
  if (state === "error") return "错误";
  return job.enabled ? "启用" : "暂停";
}

function cronResultLine(job: CronJob): string | null {
  const status = cronText(job.last_status);
  if (!status) return null;
  if (status === "ok") return "上次结果：成功";
  if (status === "error") return `上次结果：失败${cronText(job.last_error) ? ` · ${cronText(job.last_error)}` : ""}`;
  return `上次结果：${status}`;
}

function cronIsPaused(job: CronJob): boolean {
  return !job.enabled || cronState(job) === "paused";
}

function formatCronTime(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const date = typeof value === "number"
    ? new Date(value < 1_000_000_000_000 ? value * 1000 : value)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function cronActionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "请求失败");
}

type CronFeedback = {
  tone: "ok" | "info" | "error";
  message: string;
};

export function CronSection() {
  const { data: jobs, isLoading, isError, error, refetch } = useCronJobs();
  const activeProfile = useActiveProfileName();
  const createJob = useCreateCronJob();
  const deleteJob = useDeleteCronJob();
  const cronAction = useCronAction();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSchedule, setNewSchedule] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [feedback, setFeedback] = useState<CronFeedback | null>(null);
  const refreshTimersRef = useRef<number[]>([]);

  const clearQueuedRefreshes = useCallback(() => {
    refreshTimersRef.current.forEach((id) => window.clearTimeout(id));
    refreshTimersRef.current = [];
  }, []);

  const queueFollowUpRefreshes = useCallback(() => {
    clearQueuedRefreshes();
    refreshTimersRef.current = [2_000, 8_000, 30_000, 65_000].map((delay) =>
      window.setTimeout(() => void refetch(), delay),
    );
  }, [clearQueuedRefreshes, refetch]);

  useEffect(() => clearQueuedRefreshes, [clearQueuedRefreshes]);

  const handleCreate = () => {
    if (!newSchedule || !newPrompt) return;
    createJob.mutate(
      { name: newName || undefined, schedule: newSchedule, prompt: newPrompt, profile: activeProfile || "default" },
      {
        onSuccess: (job) => {
          setShowNew(false);
          setNewName("");
          setNewSchedule("");
          setNewPrompt("");
          setFeedback({ tone: "ok", message: `已创建定时任务「${cronTitle(job)}」。` });
        },
        onError: (err) => setFeedback({ tone: "error", message: `创建定时任务失败：${cronActionError(err)}` }),
      },
    );
  };

  const handleCronAction = (job: CronJob, action: "pause" | "resume" | "trigger") => {
    cronAction.mutate(
      { id: job.id, profile: cronJobProfile(job), action },
      {
        onSuccess: (updated) => {
          if (action === "trigger") {
            setFeedback({
              tone: "info",
              message: `已触发「${cronTitle(updated)}」，内核会在下一次调度 tick 执行，通常 60 秒内会刷新运行结果。`,
            });
            queueFollowUpRefreshes();
            return;
          }
          setFeedback({
            tone: "ok",
            message: `${action === "pause" ? "已暂停" : "已恢复"}「${cronTitle(updated)}」。`,
          });
        },
        onError: (err) => {
          const actionLabel = action === "pause" ? "暂停" : action === "resume" ? "恢复" : "触发";
          setFeedback({ tone: "error", message: `${actionLabel}定时任务失败：${cronActionError(err)}` });
        },
      },
    );
  };

  const handleDelete = (job: CronJob) => {
    deleteJob.mutate({ id: job.id, profile: cronJobProfile(job) }, {
      onSuccess: () => setFeedback({ tone: "ok", message: `已删除定时任务「${cronTitle(job)}」。` }),
      onError: (err) => setFeedback({ tone: "error", message: `删除定时任务失败：${cronActionError(err)}` }),
    });
  };

  return (
    <div>
      <p className={s.desc}>Agent 会按计划自动执行这些任务。</p>
      {feedback && (
        <Alert className={s.cronFeedback} tone={feedback.tone} size="sm">
          {feedback.message}
        </Alert>
      )}
      {isLoading && <LoadingState variant="block" label="正在加载定时任务…" />}
      {isError && (
        <div className={s.providerDetail} style={{ marginTop: 12 }}>
          <div className={s.desc}>加载定时任务失败：{error instanceof Error ? error.message : String(error)}</div>
          <Button variant="outline" onClick={() => void refetch()}>重试</Button>
        </div>
      )}
      {!isLoading && !isError && jobs && jobs.length === 0 && !showNew && <div className={s.desc}>暂无定时任务。</div>}
      {!isError && jobs?.map((job) => {
        const paused = cronIsPaused(job);
        return (
          <div key={`${job.profile ?? "default"}:${job.id}`} className={s.row}>
            <div className={s.rowLeft}>
              <div className={s.rowLabel}>{cronTitle(job)}</div>
              <div className={s.rowSub}>{cronScheduleDisplay(job)} · {cronPromptPreview(job).slice(0, 60)}</div>
              <div className={s.rowSub}>下次：{formatCronTime(job.next_run_at ?? job.next_run)} · 上次：{formatCronTime(job.last_run_at ?? job.last_run)}</div>
              {cronResultLine(job) && <div className={s.rowSub}>{cronResultLine(job)}</div>}
            </div>
            <div className={s.rowRight} style={{ gap: 8 }}>
              <span className={s.statusBadge} data-on={!paused}>{cronStateLabel(job)}</span>
              <Button variant="outline" disabled={cronAction.isPending || deleteJob.isPending} onClick={() => handleCronAction(job, paused ? "resume" : "pause")}>
                {paused ? "恢复" : "暂停"}
              </Button>
              <Button variant="outline" disabled={cronAction.isPending || deleteJob.isPending} onClick={() => handleCronAction(job, "trigger")}>触发</Button>
              <Button variant="outline" tone="danger" disabled={cronAction.isPending || deleteJob.isPending} onClick={() => handleDelete(job)}>删除</Button>
            </div>
          </div>
        );
      })}
      {showNew ? (
        <div className={s.providerDetail} style={{ marginTop: 12 }}>
          <FieldRow label="名称（可选）" value={newName} onChange={setNewName} />
          <FieldRow label="Cron 表达式" value={newSchedule} onChange={setNewSchedule} placeholder="0 9 * * *" />
          <FieldRow label="Prompt" value={newPrompt} onChange={setNewPrompt} placeholder="每天执行的任务描述…" />
          <div className={s.providerActions}>
            <Button variant="solid" tone="accent" onClick={handleCreate} disabled={createJob.isPending}>创建</Button>
            <Button variant="outline" onClick={() => setShowNew(false)} disabled={createJob.isPending}>取消</Button>
          </div>
        </div>
      ) : (
        <Button variant="solid" tone="accent" style={{ marginTop: 12 }} onClick={() => setShowNew(true)}>＋ 新建定时任务</Button>
      )}
    </div>
  );
}

/* ── Logs ─────────────────────────────────────────────────────────────── */

const LOG_FILES = ["agent", "errors", "gateway"] as const;
const LOG_LEVELS = ["ALL", "DEBUG", "INFO", "WARNING", "ERROR"] as const;
const LOG_COMPONENTS = ["all", "gateway", "agent", "tools", "cli", "cron"] as const;
const LOG_LINE_COUNTS = [50, 100, 200, 500] as const;

function classifyLine(line: string): "error" | "warning" | "debug" | "info" {
  const upper = line.toUpperCase();
  if (upper.includes("ERROR") || upper.includes("CRITICAL") || upper.includes("FATAL")) return "error";
  if (upper.includes("WARNING") || upper.includes("WARN")) return "warning";
  if (upper.includes("DEBUG")) return "debug";
  return "info";
}

export function LogsSection() {
  const [file, setFile] = useState<string>("agent");
  const [level, setLevel] = useState<string>("ALL");
  const [component, setComponent] = useState<string>("all");
  const [lineCount, setLineCount] = useState<number>(100);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, refetch } = useLogs(file, lineCount, level, component);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => refetch(), 5000);
    return () => clearInterval(id);
  }, [autoRefresh, refetch]);

  useEffect(() => {
    if (data && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data]);

  return (
    <div>
      <div className={s.filterBar}>
        <FilterGroup label="文件">
          {LOG_FILES.map((f) => (
            <button key={f} className={s.segmentBtn} data-active={f === file} onClick={() => setFile(f)}>{f}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="级别">
          {LOG_LEVELS.map((l) => (
            <button key={l} className={s.segmentBtn} data-active={l === level} onClick={() => setLevel(l)}>{l}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="组件">
          {LOG_COMPONENTS.map((c) => (
            <button key={c} className={s.segmentBtn} data-active={c === component} onClick={() => setComponent(c)}>{c}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="行数">
          {LOG_LINE_COUNTS.map((n) => (
            <button key={n} className={s.segmentBtn} data-active={n === lineCount} onClick={() => setLineCount(n)}>{n}</button>
          ))}
        </FilterGroup>
      </div>

      <div className={s.logToolbar}>
        <label className={s.autoRefreshLabel}>
          <button className={s.toggle} data-on={autoRefresh} onClick={() => setAutoRefresh(!autoRefresh)}>
            <span className={s.toggleThumb} />
          </button>
          <span>自动刷新</span>
          {autoRefresh && <StatusDot tone="success" />}
        </label>
        <Button variant="outline" onClick={() => void refetch()} loading={isLoading}>
          刷新
        </Button>
      </div>

      <div className={s.logBlock} ref={scrollRef} style={{ maxHeight: "calc(100vh - 340px)", minHeight: 300 }}>
        {data?.lines.map((line, i) => {
          const cls = classifyLine(line);
          return <div key={i} className={`${s.logLine} ${s[`logLine_${cls}`] ?? ""}`}>{line}</div>;
        })}
        {data && data.lines.length === 0 && <div className={s.logLine}>（无日志）</div>}
        {!data && isLoading && <LoadingState variant="block" label="正在加载日志…" />}
      </div>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={s.filterGroup}>
      <span className={s.filterLabel}>{label}</span>
      <div className={s.segmented}>{children}</div>
    </div>
  );
}

/* ── Kernel ──────────────────────────────────────────────────────────── */

export function AboutSection({ showHeading = true }: SettingsSectionProps) {
  const [desktopUpdateResult, setDesktopUpdateResult] = useState<DesktopUpdateCheckResult | null>(null);
  const [desktopUpdateChecking, setDesktopUpdateChecking] = useState(false);
  const hasDesktopUpdateBridge = typeof window !== "undefined" && Boolean(window.hermesDesktop?.checkDesktopUpdate);

  const handleCheckDesktopUpdate = async () => {
    setDesktopUpdateChecking(true);
    try {
      setDesktopUpdateResult(await checkDesktopUpdate());
    } finally {
      setDesktopUpdateChecking(false);
    }
  };

  const handleOpenDesktopDownload = () => {
    void openExternalUrl(desktopUpdateResult?.downloadUrl ?? DESKTOP_UPDATE_DOWNLOAD_URL);
  };

  // Developer mode ships enabled; the shortcut to open devtools follows the
  // platform's browser convention (registered in web/src/lib/tauri-bridge.ts).
  const devtoolsShortcut =
    detectHostOS() === "macos" ? "F12 或 ⌘ + ⌥ + I" : "F12 或 Ctrl + Shift + I";

  return (
    <div className={s.aboutSection}>
      {showHeading && <h2 className={s.heading}>关于</h2>}
      <div className={s.aboutDebugGrid}>

        <DebugCard icon={<Bug size={16} />} title="开发者工具" sub="默认开启开发者模式，可用快捷键打开 DevTools">
          <div className={s.runtimeGrid}>
            <RuntimeField label="开发者模式" value="已默认开启" />
            <RuntimeField label="打开快捷键" value={devtoolsShortcut} mono />
          </div>
          <p className={s.desc}>
            本桌面端默认开启开发者模式，按上述快捷键即可打开 / 关闭浏览器开发者工具（DevTools），
            用于查看控制台日志、网络请求等，方便排查问题或向社区反馈。再次按下快捷键可以关闭。
          </p>
        </DebugCard>

        <DebugCard icon={<Heart size={16} />} title="致谢与许可" sub="贡献者、支持方与字体署名">
          <div className={s.thanksText}>
            <p>
              感谢 Hermes Agent 官方
              <ExternalTextLink href="https://nousresearch.com/">Nous Research</ExternalTextLink>
              的支持。
            </p>

            <p>
              界面内置并使用华为 HarmonyOS Sans（SC，© 2021 Huawei Device Co., Ltd.），依据
              <ExternalTextLink href="https://github.com/ajacocks/harmonyos-sans-font/blob/main/LICENSE">
                《HarmonyOS Sans Fonts License Agreement》
              </ExternalTextLink>
              免费用于商业用途，以未修改的原始文件随应用分发。
            </p>
          </div>
        </DebugCard>

        <DebugCard icon={<GitFork size={16} />} title="项目链接" sub="桌面端与内核仓库" wide>
          <div className={s.runtimeGrid}>
            <ExternalLinkField
              label="桌面端"
              href="https://github.com/Eynzof/hermes-agent-cn-desktop"
              text="github.com/Eynzof/hermes-agent-cn-desktop"
              wide
            />
            <ExternalLinkField
              label="内核"
              href="https://github.com/Eynzof/hermes-agent-cn"
              text="github.com/Eynzof/hermes-agent-cn"
              wide
            />
          </div>
        </DebugCard>
      </div>

      <footer className={s.wandermindsFooter}>
        <a
          className={s.wandermindsCredit}
          href="https://wanderminds.ai"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            event.preventDefault();
            void openExternalUrl("https://wanderminds.ai");
          }}
          title="Wanderminds · wanderminds.ai"
        >
          <span className={s.wandermindsCreditLabel}>Designed by</span>
          <WandermindsMark className={s.wandermindsCreditLogo} />
        </a>
        <p className={s.wandermindsCopyright}>© 2026 Wanderminds, LLC · All rights reserved</p>
      </footer>
    </div>
  );
}

function DebugCard({ icon, title, sub, children, wide }: {
  icon: React.ReactNode;
  title: string;
  sub?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={s.debugCard} data-wide={wide ? "true" : undefined}>
      <div className={s.debugCardHeader}>
        <div className={s.debugCardIcon}>{icon}</div>
        <div>
          <h3>{title}</h3>
          {sub && <p>{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function RuntimeField({ label, value, mono, wide, title }: {
  label: string;
  value: string | number | boolean | undefined;
  mono?: boolean;
  wide?: boolean;
  title?: string;
}) {
  const display = value === undefined || value === "" ? "—" : String(value);
  return (
    <div className={s.runtimeField} data-wide={wide ? "true" : undefined} title={title}>
      <span>{label}</span>
      <b data-mono={mono ? "true" : undefined}>{display}</b>
    </div>
  );
}

function ExternalLinkField({ label, href, text, wide }: {
  label: string;
  href: string;
  text: string;
  wide?: boolean;
}) {
  return (
    <div className={s.runtimeField} data-wide={wide ? "true" : undefined}>
      <span>{label}</span>
      <b data-mono="true">
        <ExternalTextLink href={href}>{text}</ExternalTextLink>
      </b>
    </div>
  );
}

function ContactField({ label, children, className }: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`${s.runtimeField} ${className ?? ""}`} data-wide="true">
      <span>{label}</span>
      <div className={s.contactLines}>{children}</div>
    </div>
  );
}

function ContactCopyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className={s.contactCopyLine}>
      <span className={s.contactCopyLabel}>{label}：</span>
      <b className={s.contactCopyValue}>{value}</b>
      <CopyButton className={s.contactCopyButton} text={value} showStatusIcon={false}>
        复制
      </CopyButton>
    </div>
  );
}

function ExternalTextLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className={`${s.link} ${s.externalLink}`}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(href);
      }}
    >
      {children}
      <ExternalLinkIcon size={12} aria-hidden="true" />
    </a>
  );
}

function formatDesktopUpdateCheckedAt(value: number | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatDesktopUpdateMessage(
  result: DesktopUpdateCheckResult | null,
  checking: boolean,
  hasBridge: boolean,
): string {
  if (!hasBridge) return "当前环境没有桌面端更新检查能力；请直接前往官网查看最新版本。";
  if (checking) return "正在从官网读取最新桌面端版本…";
  if (!result) return "点击“检查更新”可手动读取官网最新版本。";
  if (!result.ok) return result.error ?? "桌面端更新检查失败。";
  if (result.updateAvailable) {
    return runtime.isPortable()
      ? `发现新版本 ${versionLabel(result.latestVersion)}，可前往官网下载免安装版压缩包，退出应用后覆盖解压（data 目录会保留）。`
      : `发现新版本 ${versionLabel(result.latestVersion)}，可前往官网下载新版安装包覆盖安装。`;
  }
  return `当前已是最新版本 ${versionLabel(result.currentVersion)}。`;
}

function shortCommit(commit: string | undefined): string {
  return shortHash(commit, 12);
}

function shortHash(hash: string | undefined, length: number): string {
  return hash ? hash.slice(0, length) : "";
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function Row({ label, sub, right }: { label: string; sub?: string; right: React.ReactNode }) {
  return (
    <div className={s.row}>
      <div className={s.rowLeft}>
        <div className={s.rowLabel}>{label}</div>
        {sub && <div className={s.rowSub}>{sub}</div>}
      </div>
      <div className={s.rowRight}>{right}</div>
    </div>
  );
}

function RadioGroup({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className={s.radioGroup}>
      {options.map((o) => (
        <button key={o.value} className={s.radioBtn} data-active={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

function ConfigFieldRow({ fieldKey, field, value, onSave, showCategory }: {
  fieldKey: string; field: ConfigSchemaField; value: any; onSave: (val: any) => void; showCategory?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [localVal, setLocalVal] = useState(String(value ?? ""));

  const handleSave = () => {
    let parsed: any = localVal;
    if (field.type === "number") parsed = Number(localVal);
    if (field.type === "boolean") parsed = localVal === "true";
    onSave(parsed);
    setEditing(false);
  };

  const label = translateConfigField(fieldKey, field.description || fieldKey);

  if (field.type === "select" && field.options) {
    return (
      <Row
        label={label}
        sub={showCategory ? `[${CATEGORY_CN[field.category] ?? field.category}] ${fieldKey}` : fieldKey}
        right={<Select value={String(value ?? "")} onChange={(e) => onSave(e.target.value)}>{field.options.map((o) => <option key={o} value={o}>{translateConfigOption(fieldKey, o)}</option>)}</Select>}
      />
    );
  }

  if (field.type === "boolean") {
    return (
      <Row
        label={label}
        sub={showCategory ? `[${CATEGORY_CN[field.category] ?? field.category}] ${fieldKey}` : fieldKey}
        right={<button className={s.toggle} data-on={!!value} onClick={() => onSave(!value)}><span className={s.toggleThumb} /></button>}
      />
    );
  }

  return (
    <Row
      label={label}
      sub={showCategory ? `[${CATEGORY_CN[field.category] ?? field.category}] ${fieldKey}` : fieldKey}
      right={editing ? (
        <div style={{ display: "flex", gap: 8 }}>
          <Input mono value={localVal} onChange={(e) => setLocalVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSave()} autoFocus style={{ width: 200 }} fullWidth={false} />
          <Button variant="solid" tone="accent" onClick={handleSave}>保存</Button>
          <Button variant="outline" onClick={() => setEditing(false)}>取消</Button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontFamily: "var(--h-font-mono)", fontSize: 12, color: "var(--h-text-2)" }}>{value != null ? String(value) : "—"}</span>
          <Button variant="outline" onClick={() => { setLocalVal(String(value ?? "")); setEditing(true); }}>编辑</Button>
        </div>
      )}
    />
  );
}

function FieldRow({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <Field label={label} className={s.fieldRow}>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </Field>
  );
}

/* ── Utilities ───────────────────────────────────────────────────────── */

function getNestedValue(obj: any, path: string): any {
  if (!obj) return undefined;
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = fn(item);
    (result[key] ??= []).push(item);
  }
  return result;
}
