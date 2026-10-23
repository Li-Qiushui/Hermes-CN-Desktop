// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DEFAULT_SSH_TARGET, type SavedSshTarget, type SshValidationErrors } from "@/lib/connection-registry";
import type { SshHostEntry } from "@/lib/ssh-config";
import { SshTargetFields } from "./ssh-target-fields";

const HOSTS: SshHostEntry[] = [
  { host: "prod-api", aliases: ["prod-api", "prod"], hostName: "10.0.0.11", user: "deploy", port: 2222, identityFile: "~/.ssh/id_prod" },
  { host: "db", aliases: ["db"], hostName: "db.internal" },
];

function setup(target: SavedSshTarget, errors: SshValidationErrors = {}) {
  const onChange = vi.fn();
  render(
    <SshTargetFields
      target={target}
      errors={errors}
      onChange={onChange}
      hosts={HOSTS}
      configPath="/home/demo/.ssh/config"
    />,
  );
  return onChange;
}

afterEach(() => {
  cleanup();
});

describe("SshTargetFields", () => {
  it("renders every ssh field", () => {
    setup({ ...DEFAULT_SSH_TARGET, host: "prod-api" });
    expect(screen.getByTestId("ssh-host-input")).toBeTruthy();
    expect(screen.getByTestId("ssh-user-input")).toBeTruthy();
    expect(screen.getByTestId("ssh-port-input")).toBeTruthy();
    expect(screen.getByTestId("ssh-key-input")).toBeTruthy();
    expect(screen.getByTestId("ssh-remote-port-input")).toBeTruthy();
    expect(screen.getByTestId("ssh-remote-path-input")).toBeTruthy();
    expect(screen.getByTestId("ssh-remote-profile-input")).toBeTruthy();
  });

  it("offers ssh config hosts as datalist suggestions", () => {
    setup({ ...DEFAULT_SSH_TARGET });
    const options = Array.from(document.querySelectorAll("datalist option")).map((option) =>
      option.getAttribute("value"),
    );
    expect(options).toEqual(["prod-api", "db"]);
  });

  it("explains which ssh config entry matched", () => {
    setup({ ...DEFAULT_SSH_TARGET, host: "prod" });
    expect(screen.getByTestId("ssh-field-host").textContent).toContain("10.0.0.11");
  });

  it("shows the config path when no entry matches", () => {
    setup({ ...DEFAULT_SSH_TARGET, host: "unknown" });
    expect(screen.getByTestId("ssh-field-host").textContent).toContain("/home/demo/.ssh/config");
  });

  it("surfaces validation errors", () => {
    setup({ ...DEFAULT_SSH_TARGET }, { host: "SSH 主机不能为空", port: "端口需为 1-65535 的整数" });
    expect(screen.getByTestId("ssh-field-host-error").textContent).toBe("SSH 主机不能为空");
    expect(screen.getByTestId("ssh-field-port-error").textContent).toBe("端口需为 1-65535 的整数");
  });

  it("emits patches for edited fields", () => {
    const onChange = setup({ ...DEFAULT_SSH_TARGET });
    fireEvent.change(screen.getByTestId("ssh-host-input"), { target: { value: "box" } });
    expect(onChange).toHaveBeenCalledWith({ host: "box" });
    fireEvent.change(screen.getByTestId("ssh-port-input"), { target: { value: "2222" } });
    expect(onChange).toHaveBeenCalledWith({ port: 2222 });
    fireEvent.change(screen.getByTestId("ssh-remote-profile-input"), { target: { value: "work" } });
    expect(onChange).toHaveBeenCalledWith({ remoteProfile: "work" });
  });

  it("falls back to the previous port when the input is not numeric", () => {
    const onChange = setup({ ...DEFAULT_SSH_TARGET, port: 2222 });
    fireEvent.change(screen.getByTestId("ssh-port-input"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith({ port: 2222 });
  });
});
