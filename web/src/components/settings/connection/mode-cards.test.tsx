// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ConnectionModeCards, MODE_OPTIONS } from "./mode-cards";

afterEach(() => {
  cleanup();
});

describe("ConnectionModeCards", () => {
  it("renders all four connection modes", () => {
    render(<ConnectionModeCards value="local" onChange={() => {}} />);
    for (const option of MODE_OPTIONS) {
      expect(screen.getByTestId(`mode-card-${option.mode}`)).toBeTruthy();
    }
    expect(MODE_OPTIONS.map((option) => option.mode)).toEqual(["local", "remote", "cloud", "ssh"]);
  });

  it("marks the selected card active", () => {
    render(<ConnectionModeCards value="cloud" onChange={() => {}} />);
    expect(screen.getByTestId("mode-card-cloud").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("mode-card-local").getAttribute("data-active")).toBe("false");
  });

  it("emits the clicked mode", () => {
    const onChange = vi.fn();
    render(<ConnectionModeCards value="local" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("mode-card-ssh"));
    expect(onChange).toHaveBeenCalledWith("ssh");
  });

  it("shows the saved target badge only for the persisted mode", () => {
    render(<ConnectionModeCards value="local" onChange={() => {}} currentMode="remote" />);
    expect(screen.getByTestId("mode-card-remote").textContent).toContain("当前目标");
    expect(screen.getByTestId("mode-card-local").textContent).not.toContain("当前目标");
  });

  it("disables every card when disabled", () => {
    render(<ConnectionModeCards value="local" onChange={() => {}} disabled />);
    for (const option of MODE_OPTIONS) {
      expect((screen.getByTestId(`mode-card-${option.mode}`) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
