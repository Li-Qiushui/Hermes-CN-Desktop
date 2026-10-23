import { beforeEach, describe, expect, it } from "vitest";

import {
  CONNECTION_KIND_LABELS,
  CONNECTION_REGISTRY_KEY,
  DEFAULT_SSH_TARGET,
  connectionToConfigInput,
  createConnectionId,
  findConnectionByUrl,
  hasSshErrors,
  nextConnectionName,
  normalizeConnection,
  normalizeRegistry,
  normalizeSshTarget,
  readActiveConnectionId,
  readConnectionRegistry,
  removeAndPersist,
  removeConnection,
  sshTargetSummary,
  tokenRefFor,
  upsertAndPersist,
  upsertConnection,
  validateSshTarget,
  writeActiveConnectionId,
  writeConnectionRegistry,
  type SavedConnection,
} from "./connection-registry";
import { __resetUiStoreForTests } from "./ui-store";

function entry(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: "remote-1",
    kind: "remote",
    name: "远程 Hermes",
    url: "https://gw.example.com",
    tokenRef: "remote-1-token",
    ssh: null,
    createdAt: 1,
    lastUsedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  __resetUiStoreForTests();
});

describe("registry persistence", () => {
  it("adds, keeps unique ids, and removes entries", () => {
    const first = upsertConnection([], entry());
    const second = upsertConnection(first, entry({ id: "remote-2", url: "https://b.example.com" }));
    expect(second).toHaveLength(2);
    expect(removeConnection(second, "remote-1")).toHaveLength(1);
  });

  it("replaces an entry with the same id instead of appending", () => {
    const list = upsertConnection([entry()], entry({ name: "改名" }));
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("改名");
  });

  it("round-trips through the ui store", () => {
    writeConnectionRegistry([entry()]);
    expect(readConnectionRegistry()).toEqual([entry()]);
  });

  it("drops the active pointer and secret ref when removing", () => {
    writeConnectionRegistry([entry()]);
    writeActiveConnectionId("remote-1");
    const next = removeAndPersist("remote-1");
    expect(next).toEqual([]);
    expect(readActiveConnectionId()).toBeNull();
  });

  it("persists the active connection id", () => {
    writeActiveConnectionId("ssh-9");
    expect(readActiveConnectionId()).toBe("ssh-9");
    writeActiveConnectionId(null);
    expect(readActiveConnectionId()).toBeNull();
  });

  it("ignores corrupt storage payloads", () => {
    __resetUiStoreForTests({ [CONNECTION_REGISTRY_KEY]: "not-an-array" });
    expect(readConnectionRegistry()).toEqual([]);
    __resetUiStoreForTests({ [CONNECTION_REGISTRY_KEY]: [{ kind: "nope", id: "x" }] });
    expect(readConnectionRegistry()).toEqual([]);
  });
});

describe("normalization", () => {
  it("fills defaults for a partial ssh target", () => {
    expect(normalizeSshTarget({ host: " box " })).toEqual({
      ...DEFAULT_SSH_TARGET,
      host: "box",
    });
  });

  it("rejects invalid ports and keeps valid ones", () => {
    expect(normalizeSshTarget({ host: "a", port: 70000 }).port).toBe(22);
    expect(normalizeSshTarget({ host: "a", port: 2200 }).port).toBe(2200);
  });

  it("normalizes a stored entry and names unnamed ones", () => {
    const normalized = normalizeConnection({ id: "abc", kind: "cloud", url: " https://c.example.com " });
    expect(normalized).toMatchObject({
      id: "abc",
      kind: "cloud",
      name: CONNECTION_KIND_LABELS.cloud,
      url: "https://c.example.com",
      tokenRef: null,
    });
  });

  it("dedupes ids while normalizing a list", () => {
    const list = normalizeRegistry([
      { id: "a", kind: "remote", url: "https://a" },
      { id: "a", kind: "remote", url: "https://b" },
      { id: "b", kind: "unknown" },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe("https://a");
  });
});

describe("naming and lookup", () => {
  it("numbers duplicate names per kind", () => {
    const list = [entry({ name: "远程 Hermes" })];
    expect(nextConnectionName(list, "remote")).toBe("远程 Hermes 2");
    expect(nextConnectionName([], "ssh")).toBe(CONNECTION_KIND_LABELS.ssh);
  });

  it("matches urls ignoring trailing slashes and case", () => {
    expect(findConnectionByUrl([entry()], "remote", "https://GW.example.com/")?.id).toBe("remote-1");
    expect(findConnectionByUrl([entry()], "cloud", "https://gw.example.com")).toBeUndefined();
  });

  it("creates distinct ids", () => {
    const a = createConnectionId("ssh", 1000);
    const b = createConnectionId("ssh", 1000);
    expect(a).not.toBe(b);
    expect(a.startsWith("ssh-")).toBe(true);
    expect(tokenRefFor("ssh-1")).toBe("ssh-1-token");
  });
});

describe("ssh validation", () => {
  it("requires a host", () => {
    const errors = validateSshTarget({ ...DEFAULT_SSH_TARGET });
    expect(errors.host).toContain("不能为空");
    expect(hasSshErrors(errors)).toBe(true);
  });

  it("rejects spaces in the host and bad users", () => {
    const errors = validateSshTarget({
      ...DEFAULT_SSH_TARGET,
      host: "my box",
      user: "bad@user",
    });
    expect(errors.host).toBeTruthy();
    expect(errors.user).toBeTruthy();
  });

  it("rejects out-of-range ports", () => {
    const errors = validateSshTarget({ ...DEFAULT_SSH_TARGET, host: "box", port: 0, remotePort: 70000 });
    expect(errors.port).toBeTruthy();
    expect(errors.remotePort).toBeTruthy();
  });

  it("requires absolute or ~ key paths", () => {
    expect(validateSshTarget({ ...DEFAULT_SSH_TARGET, host: "box", keyPath: "keys/id_rsa" }).keyPath).toBeTruthy();
    expect(validateSshTarget({ ...DEFAULT_SSH_TARGET, host: "box", keyPath: "~/.ssh/id_rsa" }).keyPath).toBeUndefined();
    expect(
      validateSshTarget({ ...DEFAULT_SSH_TARGET, host: "box", keyPath: "C:\\Users\\me\\.ssh\\id" }).keyPath,
    ).toBeUndefined();
  });

  it("restricts profile names", () => {
    expect(validateSshTarget({ ...DEFAULT_SSH_TARGET, host: "box", remoteProfile: "bad name" }).remoteProfile).toBeTruthy();
    expect(validateSshTarget({ ...DEFAULT_SSH_TARGET, host: "box", remoteProfile: "work-2" }).remoteProfile).toBeUndefined();
  });

  it("accepts a fully valid target", () => {
    const errors = validateSshTarget({
      host: "prod",
      user: "deploy",
      port: 2222,
      keyPath: "~/.ssh/id_prod",
      remoteHermesPath: "/opt/hermes/bin/hermes",
      remoteProfile: "default",
      remotePort: 9119,
    });
    expect(hasSshErrors(errors)).toBe(false);
  });

  it("summarizes the target for the list", () => {
    expect(sshTargetSummary({ ...DEFAULT_SSH_TARGET, host: "prod", user: "deploy", port: 2222 })).toBe(
      "deploy@prod:2222",
    );
    expect(sshTargetSummary({ ...DEFAULT_SSH_TARGET })).toBe("未填写主机");
  });
});

describe("connectionToConfigInput", () => {
  it("maps local connections to local mode", () => {
    expect(connectionToConfigInput(entry({ kind: "local", url: "http://127.0.0.1:9119" }))).toEqual({
      mode: "local",
      localUrl: "http://127.0.0.1:9119",
    });
  });

  it("maps remote/cloud to remote mode with the given token", () => {
    expect(connectionToConfigInput(entry({ kind: "cloud" }), "tok")).toEqual({
      mode: "remote",
      remoteUrl: "https://gw.example.com",
      remoteToken: "tok",
      remoteAuthMode: "token",
    });
  });
});
