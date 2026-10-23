// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityRouteGuard } from "./capability-route-guard";
import { classifyGatewayError } from "@/lib/gateway-result";
import {
  forgetGatewayCapabilities,
  rememberUnsupportedMethod,
} from "@/lib/gateway-capabilities";

function markUnsupported(method: string) {
  rememberUnsupportedMethod(classifyGatewayError(new Error(`当前内核不支持该功能（${method}）`)));
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderRoute(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/tasks/:taskId"
          element={
            <CapabilityRouteGuard feature="session.detail">
              <span data-testid="detail-body">会话详情</span>
            </CapabilityRouteGuard>
          }
        />
        <Route path="/" element={<span data-testid="workbench">工作台</span>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => forgetGatewayCapabilities());
afterEach(() => cleanup());

describe("CapabilityRouteGuard", () => {
  it("能力正常时渲染页面本体", () => {
    renderRoute("/tasks/abc123");

    expect(screen.getByTestId("detail-body")).toBeTruthy();
    expect(screen.queryByTestId("feature-unsupported")).toBeNull();
  });

  it("直达 URL 但内核缺能力时给兜底页，而不是白屏", () => {
    markUnsupported("session.resume");

    renderRoute("/tasks/abc123");

    expect(screen.queryByTestId("detail-body")).toBeNull();
    const fallback = screen.getByTestId("feature-unsupported");
    expect(fallback.textContent).toContain("当前内核不支持该功能");
    expect(screen.getByTestId("feature-unsupported-detail").textContent).toContain("session.resume");
  });

  it("兜底页的「返回工作台」把人送回 /", () => {
    markUnsupported("session.resume");

    renderRoute("/tasks/abc123");
    fireEvent.click(screen.getByTestId("feature-unsupported-back"));

    expect(screen.getByTestId("location").textContent).toBe("/");
    expect(screen.getByTestId("workbench")).toBeTruthy();
  });
});
