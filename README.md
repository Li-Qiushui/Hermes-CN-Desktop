# Hermes Agent CN Desktop

[Tauri v2](https://v2.tauri.app/) + Rust + React 构建的 Hermes Agent 桌面客户端，内置 [Hermes-CN-Core](https://github.com/Eynzof/Hermes-CN-Core) 内核。

本仓库是 [Eynzof/Hermes-CN-Desktop](https://github.com/Eynzof/Hermes-CN-Desktop) 的精简分支，默认分支 `slim`。只做减法，不加功能。

## 与原版的区别

共 27 处改动，逐条位置、理由与回滚方式见 [FORK-NOTES.md](./FORK-NOTES.md)。摘要：

- 去掉品牌区「中文社区桌面版 · hermesagent.org.cn」，窗口标题与托盘提示同步去掉品牌后缀
- 去掉 11 处服务商邀请码，以及远端 provider catalog 下发的推广徽章
- 去掉遥测上报与自动更新检查
- 去掉侧栏 `§01`–`§05` 编号、`✕✕` 占位、hero 区 `NO. 001` 竖排装饰，以及删除编号后残留的 64px 空列
- 去掉 persona 市场（215 个内置人格，3.2 MB）
- 去掉设置页联系方式卡、社群二维码、赞助致谢、中转站测评横幅
- `/api/version` 返回 404 时按 `deferred` 放行，便于对接非本壳内核

其余功能（聊天、Skills、Memory、Kanban、MCP、定时任务、多平台接入、模型配置）与上游一致。

## 构建

前置：Rust stable、Node 20+、pnpm 9+。

```bash
pnpm install --frozen-lockfile

# rustup 若用 --no-modify-path 安装，PATH 里没有 cargo
export PATH="$HOME/.cargo/bin:$PATH"

# 纯壳 NSIS 安装包
pnpm run tauri:build
```

产物：`target/release/bundle/nsis/Hermes Agent CN Desktop_<version>_x64-setup.exe`

只改前端也会重编整个 crate（Tauri 把 `web/dist` 当编译输入），一轮 5–6 分钟。Rust 侧文案建议攒完一次改，不要改一句编一次。

## 开发

```bash
pnpm web:dev      # 前端
cargo run         # 外壳
# 或
pnpm tauri:dev
```

外壳只做客户端，需要连接一个已在运行的外部 Hermes（默认 `http://127.0.0.1:9119`，也可填远端地址 + Token）。

## 仓库结构

```text
├── src/          Rust：Tauri commands、进程与 runtime 管理、连接模式
├── web/          React：Vite、TanStack Query、Jotai
├── packages/     protocol（IPC 契约）、shared-ui（设计 token）
├── static/       打包时注入的 dashboard、runtime、内置 skills
└── scripts/      runtime staging 与 release staging
```

## 许可

本项目的非商业使用遵守 [PolyForm Noncommercial License 1.0.0](./LICENSE)。商业使用、商业分发、商业集成、托管销售或作为商业产品组成部分使用，需提前获得青岛万德缦思网络科技有限公司的单独商业授权；授权联系邮箱：lijiale@wanderminds.cn。

原项目版权归 [Eynzof](https://github.com/Eynzof) 所有。
