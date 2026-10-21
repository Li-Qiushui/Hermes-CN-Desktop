# Hermes Agent CN Desktop

English · [简体中文](./README.md)

A Hermes Agent desktop client built with [Tauri v2](https://v2.tauri.app/), Rust and React, bundling the [Hermes-CN-Core](https://github.com/Eynzof/Hermes-CN-Core) runtime.

This repository is a slimmed branch of [Eynzof/Hermes-CN-Desktop](https://github.com/Eynzof/Hermes-CN-Desktop); the default branch is `slim`. Only removals, no new features.

## What differs from upstream

27 changes in total; every location, rationale and rollback step is listed in [FORK-NOTES.md](./FORK-NOTES.md). Summary:

- Removed the branding block ("中文社区桌面版 · hermesagent.org.cn"), including the window title and tray tooltip suffixes
- Removed 11 provider referral codes and the promotion badges pushed by the remote provider catalog
- Removed telemetry reporting and automatic update checks
- Removed sidebar `§01`–`§05` numbering, `✕✕` placeholders, the vertical `NO. 001` hero decoration, and the 64px column left behind after the numbering was dropped
- Removed the persona marketplace (215 bundled personas, 3.2 MB)
- Removed the settings contact card, community QR code, sponsor thanks and relay-vendor review banner
- `/api/version` 404 on an attached kernel is treated as usable (version `unknown`) instead of failing the gate

Everything else (chat, Skills, Memory, Kanban, MCP, scheduled tasks, multi-platform gateways, runtime management) is unchanged from upstream.

## Build

Prerequisites: Rust stable, Node.js 20+, pnpm 9+.

```bash
pnpm install --frozen-lockfile

# cargo is missing from PATH if rustup was installed with --no-modify-path
export PATH="$HOME/.cargo/bin:$PATH"

# Shell-only NSIS installer
pnpm run tauri:build
```

Output: `target/release/bundle/nsis/Hermes Agent CN Desktop_<version>_x64-setup.exe`

Frontend-only changes still recompile the whole crate (Tauri treats `web/dist` as a compile input), roughly 5–6 minutes per round. Batch Rust-side string edits instead of rebuilding per line.

## Development

```bash
pnpm web:dev      # frontend
cargo run         # shell
# or
pnpm tauri:dev
```

The shell is client-only: it connects to an already running external Hermes (default `http://127.0.0.1:9119`, or a remote URL plus token).

## Repository layout

```text
├── src/          Rust: Tauri commands, process and runtime management, connection modes
├── web/          React: Vite, TanStack Query, Jotai
├── packages/     protocol (IPC contracts), shared-ui (design tokens)
├── static/       license and icon assets
└── scripts/      version/license sync and dev helpers
```

## License

Noncommercial use of this project is licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE). Commercial use, commercial distribution, commercial integration, hosted resale, or use as part of a commercial product or service requires a separate commercial license from Qingdao Wanderminds Network Technology Co., Ltd.; contact lijiale@wanderminds.cn for authorization.

Upstream copyright belongs to [Eynzof](https://github.com/Eynzof).
