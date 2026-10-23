// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { EnvVarInfo } from "@hermes/protocol";
import { __resetUiStoreForTests } from "@/lib/ui-store";
import { ConnectionSection } from "./settings-connection-section";

const envData: Record<string, EnvVarInfo> = {
  EXA_API_KEY: {
    is_set: true,
    redacted_value: "exa_••••1234",
    description: "Exa 搜索",
    url: null,
    category: "tool",
    is_password: true,
    tools: [],
    advanced: false,
  },
  HERMES_GATEWAY_TOKEN: {
    is_set: false,
    redacted_value: null,
    description: "网关令牌",
    url: null,
    category: "service",
    is_password: true,
    tools: [],
    advanced: false,
  },
};

vi.mock("@/hooks/use-env", () => ({
  useEnvVars: () => ({ data: envData, isLoading: false, error: null }),
  useSetEnv: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEnv: () => ({ mutate: vi.fn(), isPending: false }),
  useRevealEnv: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/transport", () => ({
  fetchJSON: vi.fn(async () => ({
    version: "0.8.0",
    gateway_state: "running",
    gateway_platforms: {},
  })),
  postJSON: vi.fn(async () => ({ ok: true })),
  putJSON: vi.fn(async () => ({ ok: true })),
  deleteJSON: vi.fn(async () => ({ ok: true })),
}));

function stubDesktop() {
  const desktop = {
    windowType: "tauri",
    getConnectionConfig: vi.fn(async () => ({
      mode: "local",
      localUrl: "http://127.0.0.1:9119",
      remoteUrl: "",
      remoteTokenSet: false,
      remoteTokenPreview: null,
      remoteAuthMode: "token",
      remoteSessionSet: false,
      envOverride: false,
      effectiveMode: "local",
    })),
    saveConnectionConfig: vi.fn(),
    applyConnectionConfig: vi.fn(async () => ({ ok: true, mode: "local" })),
    testConnectionConfig: vi.fn(async () => ({
      ok: true,
      baseUrl: "http://127.0.0.1:9119",
      httpOk: true,
      wsOk: true,
      authRequired: false,
    })),
    kernelStatus: vi.fn(async () => ({ mode: "attached", port: 9119, pid: 4321, restarts: 0 })),
  };
  (window as unknown as { hermesDesktop: unknown }).hermesDesktop = desktop;
  (window as unknown as { __HERMES_RUNTIME__: unknown }).__HERMES_RUNTIME__ = {
    platform: "web",
    connectionMode: "local",
    dashboardApiBaseUrl: "http://127.0.0.1:9119",
  };
  return desktop;
}

beforeEach(() => {
  __resetUiStoreForTests();
  stubDesktop();
});

afterEach(() => {
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop;
  delete (window as unknown as { __HERMES_RUNTIME__?: unknown }).__HERMES_RUNTIME__;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ConnectionSection four modes", () => {
  it("renders local, remote, cloud and ssh mode cards", () => {
    render(<ConnectionSection showHeading={false} />);
    expect(screen.getByTestId("connection-mode-cards")).toBeTruthy();
    for (const mode of ["local", "remote", "cloud", "ssh"]) {
      expect(screen.getByTestId(`mode-card-${mode}`)).toBeTruthy();
    }
  });

  it("switches the form when a different mode card is picked", async () => {
    render(<ConnectionSection showHeading={false} />);
    expect(screen.getByTestId("kernel-mode")).toBeTruthy();

    fireEvent.click(screen.getByTestId("mode-card-ssh"));
    await waitFor(() => expect(screen.getByTestId("ssh-host-input")).toBeTruthy());
    expect(screen.queryByTestId("kernel-mode")).toBeNull();

    fireEvent.click(screen.getByTestId("mode-card-cloud"));
    await waitFor(() => expect(screen.getByTestId("cloud-url-input")).toBeTruthy());
    expect(screen.queryByTestId("ssh-host-input")).toBeNull();

    fireEvent.click(screen.getByTestId("mode-card-remote"));
    await waitFor(() => expect(screen.getByText("远程地址")).toBeTruthy());
  });

  it("blocks an ssh connect with an invalid target and shows field errors", async () => {
    render(<ConnectionSection showHeading={false} />);
    fireEvent.click(screen.getByTestId("mode-card-ssh"));
    await waitFor(() => expect(screen.getByTestId("ssh-connect-button")).toBeTruthy());

    fireEvent.click(screen.getByTestId("ssh-connect-button"));
    await waitFor(() =>
      expect(screen.getByTestId("ssh-field-host-error").textContent).toBe("SSH 主机不能为空"),
    );
    expect(screen.getByText(/SSH 目标字段有误/)).toBeTruthy();
  });

  it("shows saved connections empty state and the encryption status", async () => {
    render(<ConnectionSection showHeading={false} />);
    await waitFor(() => expect(screen.getByTestId("saved-connections-empty")).toBeTruthy());
    expect(screen.getByTestId("secret-storage-status").textContent).toContain("未启用加密存储");
  });

  it("renders the device subpage with the kernel facts and the missing-endpoint note", async () => {
    render(<ConnectionSection showHeading={false} />);
    fireEvent.click(screen.getByTestId("panel-tab-devices"));
    await waitFor(() => expect(screen.getByTestId("device-panel")).toBeTruthy());
    expect(screen.getByTestId("device-panel-notice").textContent).toContain("内核未上报设备列表");
    expect(screen.getByTestId("device-active-mode").textContent).toBe("本机内核");
    expect(screen.getByTestId("device-kernel-port").textContent).toBe("9119");
  });

  it("renders the api key subpage split into tool and gateway groups", async () => {
    render(<ConnectionSection showHeading={false} />);
    fireEvent.click(screen.getByTestId("panel-tab-keys"));
    await waitFor(() => expect(screen.getByTestId("api-keys-section")).toBeTruthy());
    expect(screen.getByTestId("api-key-group-工具密钥")).toBeTruthy();
    expect(screen.getByTestId("api-key-group-服务端/网关密钥")).toBeTruthy();
  });
});
