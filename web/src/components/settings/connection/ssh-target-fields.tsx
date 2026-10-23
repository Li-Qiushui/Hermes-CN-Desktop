import { Input } from "@hermes/shared-ui";

import type { SavedSshTarget, SshValidationErrors } from "@/lib/connection-registry";
import type { SshHostEntry } from "@/lib/ssh-config";
import c from "./connection.module.css";

function Field({
  label,
  hint,
  error,
  wide,
  children,
  testId,
}: {
  label: string;
  hint?: string;
  error?: string;
  wide?: boolean;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className={`${c.field}${wide ? ` ${c.fieldWide}` : ""}`} data-testid={testId}>
      <span className={c.fieldLabel}>{label}</span>
      {children}
      {error ? (
        <span className={c.fieldError} data-testid={`${testId}-error`}>
          {error}
        </span>
      ) : (
        hint && <span className={c.fieldHint}>{hint}</span>
      )}
    </div>
  );
}

function parsePort(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function SshTargetFields({
  target,
  errors,
  onChange,
  hosts,
  hostsLoading,
  configPath,
  configError,
  disabled,
}: {
  target: SavedSshTarget;
  errors: SshValidationErrors;
  onChange: (patch: Partial<SavedSshTarget>) => void;
  hosts: SshHostEntry[];
  hostsLoading?: boolean;
  configPath?: string | null;
  configError?: string;
  disabled?: boolean;
}) {
  const listId = "hermes-ssh-config-hosts";
  const matched = hosts.find((entry) => entry.aliases.includes(target.host.trim()));

  return (
    <div className={c.fieldGrid}>
      <Field
        label="SSH 主机"
        testId="ssh-field-host"
        error={errors.host}
        hint={
          hostsLoading
            ? "正在读取 ~/.ssh/config…"
            : configError
              ? `ssh 配置读取失败：${configError}`
              : matched
                ? `匹配 ~/.ssh/config：${matched.hostName ?? matched.host}${matched.user ? ` · ${matched.user}` : ""}`
                : configPath
                  ? `候选来自 ${configPath}，也可直接填任意主机`
                  : "填主机名或 ssh config 里的 Host 别名"
        }
      >
        <Input
          mono
          list={listId}
          value={target.host}
          placeholder="my-server"
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange({ host: event.target.value })}
          data-testid="ssh-host-input"
        />
        <datalist id={listId}>
          {hosts.map((entry) => (
            <option key={entry.host} value={entry.host}>
              {[entry.hostName, entry.user].filter(Boolean).join(" · ")}
            </option>
          ))}
        </datalist>
      </Field>

      <Field label="用户" testId="ssh-field-user" error={errors.user} hint="留空则用 ssh 默认用户">
        <Input
          value={target.user}
          placeholder={matched?.user ?? "root"}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange({ user: event.target.value })}
          data-testid="ssh-user-input"
        />
      </Field>

      <Field label="SSH 端口" testId="ssh-field-port" error={errors.port} hint="默认 22">
        <Input
          mono
          inputMode="numeric"
          value={String(target.port)}
          placeholder="22"
          disabled={disabled}
          onChange={(event) => onChange({ port: parsePort(event.target.value, target.port) })}
          data-testid="ssh-port-input"
        />
      </Field>

      <Field
        label="私钥路径"
        testId="ssh-field-key"
        error={errors.keyPath}
        hint="可选，绝对路径或 ~/... 开头"
      >
        <Input
          mono
          value={target.keyPath}
          placeholder={matched?.identityFile ?? "~/.ssh/id_ed25519"}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange({ keyPath: event.target.value })}
          data-testid="ssh-key-input"
        />
      </Field>

      <Field
        label="远端内核端口"
        testId="ssh-field-remote-port"
        error={errors.remotePort}
        hint="远端 hermes serve 监听的端口，默认 9119"
      >
        <Input
          mono
          inputMode="numeric"
          value={String(target.remotePort)}
          placeholder="9119"
          disabled={disabled}
          onChange={(event) => onChange({ remotePort: parsePort(event.target.value, target.remotePort) })}
          data-testid="ssh-remote-port-input"
        />
      </Field>

      <Field
        label="远端 hermes 路径"
        testId="ssh-field-remote-path"
        error={errors.remoteHermesPath}
        hint="远端可执行文件路径，留空用 PATH 里的 hermes"
      >
        <Input
          mono
          value={target.remoteHermesPath}
          placeholder="/usr/local/bin/hermes"
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange({ remoteHermesPath: event.target.value })}
          data-testid="ssh-remote-path-input"
        />
      </Field>

      <Field
        label="远端 profile"
        testId="ssh-field-remote-profile"
        error={errors.remoteProfile}
        hint="可选，远端要连接的 Hermes profile 名"
      >
        <Input
          mono
          value={target.remoteProfile}
          placeholder="default"
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange({ remoteProfile: event.target.value })}
          data-testid="ssh-remote-profile-input"
        />
      </Field>
    </div>
  );
}
