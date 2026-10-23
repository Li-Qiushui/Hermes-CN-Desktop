import { describe, expect, it } from "vitest";

import {
  decodeDataUrlText,
  findSshHost,
  homeDirFromConfigDir,
  loadSshHosts,
  parseSshConfig,
  sshConfigPath,
  sshHostSuggestions,
} from "./ssh-config";

const SAMPLE = `
# global options
Host *
  ServerAliveInterval 30

Host prod-api prod
  HostName 10.0.0.11
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_prod

Host jump-*
  HostName 10.0.0.12

Host db
  HostName=db.internal
  User=root

Match host *.example.com
  User ignored

Host gpu
  HostName gpu.lab
  IdentityFile ~/.ssh/gpu_a
  IdentityFile ~/.ssh/gpu_b
`;

describe("parseSshConfig", () => {
  it("extracts concrete hosts and drops wildcard blocks", () => {
    const entries = parseSshConfig(SAMPLE);
    expect(entries.map((entry) => entry.host)).toEqual(["prod-api", "db", "gpu"]);
  });

  it("reads HostName, User, Port and IdentityFile", () => {
    const prod = parseSshConfig(SAMPLE).find((entry) => entry.host === "prod-api");
    expect(prod).toMatchObject({
      hostName: "10.0.0.11",
      user: "deploy",
      port: 2222,
      identityFile: "~/.ssh/id_prod",
    });
    expect(prod?.aliases).toEqual(["prod-api", "prod"]);
  });

  it("supports key=value form", () => {
    const db = parseSshConfig(SAMPLE).find((entry) => entry.host === "db");
    expect(db).toMatchObject({ hostName: "db.internal", user: "root" });
  });

  it("stops reading directives after Match", () => {
    const gpu = parseSshConfig(SAMPLE).find((entry) => entry.host === "gpu");
    expect(gpu?.user).toBeUndefined();
    expect(gpu?.identityFile).toBe("~/.ssh/gpu_a");
  });

  it("ignores comments, blank lines and invalid ports", () => {
    const entries = parseSshConfig(`
Host broken
  # comment inside block
  HostName broken.local
  Port 99999
  User   admin
`);
    expect(entries).toEqual([
      { host: "broken", aliases: ["broken"], hostName: "broken.local", user: "admin" },
    ]);
  });

  it("returns nothing for an empty config", () => {
    expect(parseSshConfig("")).toEqual([]);
  });
});

describe("ssh host helpers", () => {
  const entries = parseSshConfig(SAMPLE);

  it("finds a host by alias", () => {
    expect(findSshHost(entries, "prod")?.hostName).toBe("10.0.0.11");
    expect(findSshHost(entries, "missing")).toBeUndefined();
  });

  it("filters suggestions by alias or hostname", () => {
    expect(sshHostSuggestions(entries, "10.0.0.12")).toEqual([]);
    expect(sshHostSuggestions(entries, "gpu").map((entry) => entry.host)).toEqual(["gpu"]);
    expect(sshHostSuggestions(entries, "").length).toBe(entries.length);
  });

  it("builds a platform aware config path", () => {
    expect(sshConfigPath("C:\\Users\\demo")).toBe("C:\\Users\\demo\\.ssh\\config");
    expect(sshConfigPath("/home/demo/")).toBe("/home/demo/.ssh/config");
  });

  it("derives the home dir from an agent config dir", () => {
    expect(homeDirFromConfigDir("C:\\Users\\demo\\.claude")).toBe("C:\\Users\\demo");
    expect(homeDirFromConfigDir("/home/demo/.codex")).toBe("/home/demo");
    expect(homeDirFromConfigDir("/home/demo/elsewhere")).toBeNull();
    expect(homeDirFromConfigDir(undefined)).toBeNull();
  });
});

describe("loadSshHosts", () => {
  it("parses the text returned by the native reader", async () => {
    const result = await loadSshHosts({
      readConfigText: async () => ({ path: "/home/demo/.ssh/config", content: SAMPLE }),
    });
    expect(result.configPath).toBe("/home/demo/.ssh/config");
    expect(result.hosts).toHaveLength(3);
  });

  it("reports a readable error when the bridge is missing", async () => {
    const result = await loadSshHosts({ readConfigText: async () => null });
    expect(result.hosts).toEqual([]);
    expect(result.error).toContain("ssh 配置");
  });

  it("surfaces reader failures instead of throwing", async () => {
    const result = await loadSshHosts({
      readConfigText: async () => {
        throw new Error("boom");
      },
    });
    expect(result.error).toBe("boom");
  });
});

describe("decodeDataUrlText", () => {
  it("decodes a base64 data url", () => {
    const encoded = Buffer.from("Host demo\n  User me\n", "utf8").toString("base64");
    expect(decodeDataUrlText(`data:text/plain;base64,${encoded}`)).toContain("Host demo");
  });

  it("returns an empty string for non-data payloads", () => {
    expect(decodeDataUrlText("plain text")).toBe("");
  });
});
