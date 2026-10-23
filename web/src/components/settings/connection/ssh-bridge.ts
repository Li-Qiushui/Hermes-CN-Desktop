import type { SavedSshTarget } from "@/lib/connection-registry";
import { isNativeDesktop } from "@/lib/ssh-config";

export interface SshProbeOutcome {
  ok: boolean;
  host: string;
  command?: string;
  version?: string | null;
  error?: string | null;
  stderr?: string;
}

export interface SshTunnelOutcome {
  localPort: number;
  remoteUrl: string;
  pid: number;
}

function targetPayload(target: SavedSshTarget) {
  return {
    host: target.host.trim(),
    user: target.user.trim(),
    port: target.port,
    keyPath: target.keyPath.trim(),
    remoteHermesPath: target.remoteHermesPath.trim(),
    remotePort: target.remotePort,
  };
}

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(command, args);
}

export async function probeSshTarget(target: SavedSshTarget): Promise<SshProbeOutcome> {
  if (!isNativeDesktop()) {
    return { ok: false, host: target.host, error: "SSH 探测仅在桌面端可用" };
  }
  try {
    return await invokeNative<SshProbeOutcome>("ssh_probe", { target: targetPayload(target) });
  } catch (error) {
    return {
      ok: false,
      host: target.host,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function openSshTunnel(
  id: string,
  target: SavedSshTarget,
  localPort = 0,
): Promise<SshTunnelOutcome> {
  if (!isNativeDesktop()) {
    throw new Error("SSH 隧道仅在桌面端可用");
  }
  return invokeNative<SshTunnelOutcome>("ssh_tunnel_open", {
    input: { id, ...targetPayload(target), localPort },
  });
}

export async function closeSshTunnel(id: string): Promise<boolean> {
  if (!isNativeDesktop()) return false;
  try {
    return await invokeNative<boolean>("ssh_tunnel_close", { input: { id } });
  } catch {
    return false;
  }
}
