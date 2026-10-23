import { useMemo, useState } from "react";
import { Eye, EyeOff, KeyRound, ServerCog, Trash2 } from "lucide-react";
import type { EnvVarInfo } from "@hermes/protocol";
import { Alert, Button, Input, LoadingIndicator } from "@hermes/shared-ui";

import { useDeleteEnv, useEnvVars, useRevealEnv, useSetEnv } from "@/hooks/use-env";
import { groupEnvKeys, maskSecret } from "@/lib/env-key-categories";
import { translateEnvVar } from "@/lib/env-translations";
import s from "@/routes/settings.module.css";
import c from "./connection.module.css";

function KeyRow({
  envKey,
  info,
  onSave,
  onClear,
  onReveal,
  busy,
}: {
  envKey: string;
  info: EnvVarInfo;
  onSave: (value: string) => void;
  onClear: () => void;
  onReveal: () => Promise<string>;
  busy: boolean;
}) {
  const translation = translateEnvVar(envKey, info);
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealError, setRevealError] = useState("");
  const [revealing, setRevealing] = useState(false);

  const toggleReveal = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    setRevealing(true);
    setRevealError("");
    try {
      const value = await onReveal();
      setRevealed(value);
    } catch (error) {
      setRevealError(error instanceof Error ? error.message : String(error));
    } finally {
      setRevealing(false);
    }
  };

  const valueText = revealed !== null ? revealed : info.is_set ? info.redacted_value || maskSecret(info.redacted_value ?? "") || "已设置" : "未设置";

  return (
    <div className={c.keyRow} data-testid={`api-key-row-${envKey}`}>
      <div>
        <div className={c.keyName} data-testid={`api-key-name-${envKey}`}>
          {envKey}
        </div>
        <div className={c.keyDesc}>
          {translation.label !== envKey ? `${translation.label} · ` : ""}
          {translation.description || info.description || "—"}
        </div>
      </div>
      <div className={c.keyValue}>
        <span className={c.keyValueText} data-testid={`api-key-value-${envKey}`}>
          {valueText}
        </span>
        {!info.is_set && <span className={c.kindPill}>未设置</span>}
        {revealError && <span className={c.fieldError}>{revealError}</span>}
        <Input
          type="password"
          value={draft}
          placeholder={info.is_set ? "输入新值覆盖" : "粘贴密钥"}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          data-testid={`api-key-input-${envKey}`}
        />
      </div>
      <div className={c.keyActions}>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void toggleReveal()}
          disabled={busy || revealing || !info.is_set}
          leadingIcon={revealed !== null ? <EyeOff size={12} /> : <Eye size={12} />}
          data-testid={`api-key-reveal-${envKey}`}
        >
          {revealing ? "读取中…" : revealed !== null ? "隐藏" : "显示"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            onSave(draft);
            setDraft("");
          }}
          disabled={busy || !draft.trim()}
          data-testid={`api-key-save-${envKey}`}
        >
          保存
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onClear}
          disabled={busy || !info.is_set}
          leadingIcon={<Trash2 size={12} />}
          data-testid={`api-key-clear-${envKey}`}
        >
          清除
        </Button>
      </div>
    </div>
  );
}

function KeyGroup({
  title,
  subtitle,
  icon: Icon,
  keys,
}: {
  title: string;
  subtitle: string;
  icon: typeof KeyRound;
  keys: Array<{ key: string; info: EnvVarInfo }>;
}) {
  const setEnv = useSetEnv();
  const deleteEnv = useDeleteEnv();
  const revealEnv = useRevealEnv();
  const busy = setEnv.isPending || deleteEnv.isPending;

  return (
    <section className={c.keyGroup} data-testid={`api-key-group-${title}`}>
      <div className={c.keyGroupHead}>
        <Icon size={14} aria-hidden="true" />
        <span className={c.keyGroupTitle}>{title}</span>
        <span className={c.keyGroupSub}>{subtitle}</span>
      </div>
      {keys.length === 0 ? (
        <div className={c.empty}>当前内核没有上报这一类密钥。</div>
      ) : (
        keys.map((entry) => (
          <KeyRow
            key={entry.key}
            envKey={entry.key}
            info={entry.info}
            busy={busy}
            onSave={(value) => setEnv.mutate({ key: entry.key, value })}
            onClear={() => deleteEnv.mutate(entry.key)}
            onReveal={async () => (await revealEnv.mutateAsync(entry.key)).value}
          />
        ))
      )}
    </section>
  );
}

export function ApiKeysSection({ showHeading = true }: { showHeading?: boolean }) {
  const env = useEnvVars();
  const groups = useMemo(() => groupEnvKeys(env.data ?? {}), [env.data]);
  const error = env.error instanceof Error ? env.error.message : env.error ? String(env.error) : "";

  return (
    <div data-testid="api-keys-section">
      {showHeading && <h2 className={s.heading}>API 密钥</h2>}
      <div className={c.notice}>
        <KeyRound size={14} aria-hidden="true" />
        <span>
          这里读写的是本机内核的 <code>.env</code>：工具密钥给搜索/抓取一类的工具用，网关密钥给服务端和外部接入用。保存后立即生效，值以密文回显。
        </span>
      </div>

      {env.isLoading && (
        <div className={c.notice}>
          <LoadingIndicator size="xs" /> 正在读取密钥清单…
        </div>
      )}

      {error && (
        <Alert tone="error" size="sm">
          密钥清单读取失败：{error}
        </Alert>
      )}

      {!env.isLoading && !error && (
        <>
          <KeyGroup
            title="工具密钥"
            subtitle="搜索、抓取、浏览器等工具使用的第三方密钥"
            icon={KeyRound}
            keys={groups.tool}
          />
          <KeyGroup
            title="服务端/网关密钥"
            subtitle="本机内核、网关与外部接入使用的密钥"
            icon={ServerCog}
            keys={groups.gateway}
          />
        </>
      )}
    </div>
  );
}
