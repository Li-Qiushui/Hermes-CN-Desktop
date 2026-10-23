// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { EnvVarInfo } from "@hermes/protocol";
import { ApiKeysSection } from "./api-keys-section";

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
  TAVILY_API_KEY: {
    is_set: false,
    redacted_value: null,
    description: "Tavily 搜索",
    url: null,
    category: "tool",
    is_password: true,
    tools: [],
    advanced: false,
  },
  HERMES_GATEWAY_TOKEN: {
    is_set: true,
    redacted_value: "gw_••••9999",
    description: "网关令牌",
    url: null,
    category: "service",
    is_password: true,
    tools: [],
    advanced: false,
  },
  OPENAI_API_KEY: {
    is_set: true,
    redacted_value: "sk-••••0000",
    description: "模型服务商密钥",
    url: null,
    category: "provider",
    is_password: true,
    tools: [],
    advanced: false,
  },
};

const mutate = vi.fn();
const mutateAsync = vi.fn(async () => ({ value: "plain-text-secret" }));

vi.mock("@/hooks/use-env", () => ({
  useEnvVars: () => ({ data: envData, isLoading: false, error: null }),
  useSetEnv: () => ({ mutate, isPending: false }),
  useDeleteEnv: () => ({ mutate: vi.fn(), isPending: false }),
  useRevealEnv: () => ({ mutateAsync, isPending: false }),
}));

function Wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

afterEach(() => {
  cleanup();
});

describe("ApiKeysSection", () => {
  beforeEach(() => {
    mutate.mockClear();
    mutateAsync.mockClear();
  });

  it("renders the two key categories", () => {
    render(<ApiKeysSection showHeading={false} />, { wrapper: Wrapper });
    expect(screen.getByTestId("api-key-group-工具密钥")).toBeTruthy();
    expect(screen.getByTestId("api-key-group-服务端/网关密钥")).toBeTruthy();
  });

  it("only lists tool and gateway keys", () => {
    render(<ApiKeysSection showHeading={false} />);
    expect(screen.getByTestId("api-key-row-EXA_API_KEY")).toBeTruthy();
    expect(screen.getByTestId("api-key-row-TAVILY_API_KEY")).toBeTruthy();
    expect(screen.getByTestId("api-key-row-HERMES_GATEWAY_TOKEN")).toBeTruthy();
    expect(screen.queryByTestId("api-key-row-OPENAI_API_KEY")).toBeNull();
  });

  it("shows the redacted value and marks unset keys", () => {
    render(<ApiKeysSection showHeading={false} />);
    expect(screen.getByTestId("api-key-value-EXA_API_KEY").textContent).toBe("exa_••••1234");
    expect(screen.getByTestId("api-key-row-TAVILY_API_KEY").textContent).toContain("未设置");
  });

  it("saves an edited value", () => {
    render(<ApiKeysSection showHeading={false} />);
    fireEvent.change(screen.getByTestId("api-key-input-EXA_API_KEY"), { target: { value: "new-key" } });
    fireEvent.click(screen.getByTestId("api-key-save-EXA_API_KEY"));
    expect(mutate).toHaveBeenCalledWith({ key: "EXA_API_KEY", value: "new-key" });
  });

  it("reveals a stored value on demand", async () => {
    render(<ApiKeysSection showHeading={false} />);
    fireEvent.click(screen.getByTestId("api-key-reveal-EXA_API_KEY"));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith("EXA_API_KEY"));
    await waitFor(() =>
      expect(screen.getByTestId("api-key-value-EXA_API_KEY").textContent).toBe("plain-text-secret"),
    );
    fireEvent.click(screen.getByTestId("api-key-reveal-EXA_API_KEY"));
    await waitFor(() =>
      expect(screen.getByTestId("api-key-value-EXA_API_KEY").textContent).toBe("exa_••••1234"),
    );
  });

  it("disables reveal and clear for unset keys", () => {
    render(<ApiKeysSection showHeading={false} />);
    expect((screen.getByTestId("api-key-reveal-TAVILY_API_KEY") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("api-key-clear-TAVILY_API_KEY") as HTMLButtonElement).disabled).toBe(true);
  });
});
