// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useSession } from "@/hooks/use-sessions";
import { RouteMemory } from "./route-memory";
import { readLastRoute, rememberLastRoute } from "@/lib/route-memory";
import { writeWorkspacePath } from "@/lib/workspaces";
import { __resetUiStoreForTests } from "@/lib/ui-store";

vi.mock("@/hooks/use-sessions", () => ({
  useSession: vi.fn(),
}));

function Probe() {
  const location = useLocation();
  return <span data-testid="probe">{`${location.pathname}${location.search}`}</span>;
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <RouteMemory />
      <Routes>
        <Route path="/" element={<div>home</div>} />
        <Route path="/models" element={<div>models</div>} />
        <Route path="/history" element={<div>history</div>} />
        <Route path="/tasks/:taskId" element={<div>task</div>} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __resetUiStoreForTests();
  cleanup();
  vi.mocked(useSession).mockReturnValue({ data: undefined, isError: false } as never);
});

describe("启动恢复上次位置", () => {
  it("上次停在页面路由时直接回到那个页面", async () => {
    rememberLastRoute("/models");

    renderAt("/");

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("/models"));
    expect(readLastRoute()).toBe("/models");
  });

  it("上次停在会话页且会话还在时回到该会话", async () => {
    rememberLastRoute("/tasks/sess-1");
    vi.mocked(useSession).mockReturnValue({ data: { id: "sess-1" }, isError: false } as never);

    renderAt("/");

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("/tasks/sess-1"));
  });

  it("会话已删就留在首页并清掉记忆", async () => {
    rememberLastRoute("/tasks/gone");
    vi.mocked(useSession).mockReturnValue({ data: undefined, isError: true } as never);

    renderAt("/");

    await waitFor(() => expect(readLastRoute()).toBeNull());
    expect(screen.getByTestId("probe").textContent).toBe("/");
  });

  it("停在首页不覆盖记住的位置，进入别的页面才更新", async () => {
    rememberLastRoute("/history");

    renderAt("/history");

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("/history"));
    expect(readLastRoute()).toBe("/history");
  });

  it("首页新建会话默认带上上次用过的工作区", async () => {
    writeWorkspacePath("/repo/demo");

    renderAt("/");

    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("/?workspace=%2Frepo%2Fdemo"),
    );
  });

  it("已经带了工作区参数就不重复改写", async () => {
    writeWorkspacePath("/repo/demo");

    renderAt("/?workspace=%2Frepo%2Fother");

    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("/?workspace=%2Frepo%2Fother"),
    );
  });

  it("深链直接打开时记录当前路由", async () => {
    renderAt("/models");

    await waitFor(() => expect(readLastRoute()).toBe("/models"));
  });
});
