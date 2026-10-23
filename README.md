# Hermes Agent CN Desktop

Tauri v2 + Rust + React 写的 Hermes Agent 桌面壳。它自己拉一个本机 `hermes` 内核（或连远端），前端把那套 JSON-RPC/WS 协议翻译成中文桌面界面。

## 和官方 Hermes Desktop 的关系

- **不是官方 Desktop 的换皮，也不是 `@assistant-ui/*` 的集成方**。`web/package.json` 里没有任何 `@assistant-ui/*` 依赖，对话区（时间线、工具卡、输入框、审批卡、子代理卡）是本仓库自己写的，只复用内核协议。
- 上游是 `Eynzof/Hermes-CN-Desktop`（基线 commit `06e15d0e5d3c27f1fd37f09579f26f91c020036e`，v0.9.0）。上一阶段它是「只做减法」的精简分支；现在方向已经变成「自己托管内核 + 重写对话层」，和上游的差异不再只是删东西。
- 历史精简改动（去品牌推广、去返利链接、去遥测、去 215 个人格市场等 27 处）逐条位置和回滚方式见 [FORK-NOTES.md](./FORK-NOTES.md)，README 不重复。
- 目录布局和 Tauri 默认不同：**没有 `src-tauri/`**。`tauri.conf.json`、`Cargo.toml`、`src/`、`target/` 全在仓库根目录。照官方 Tauri 文档抄命令会找不到路径。

## 架构

三层，职责不混：Rust 管进程和网络，前端管界面，协议包管契约。

### Rust 壳（`src/`）

- `kernel_managed.rs` —— 本机内核的生命周期全在这里。
  - 先读 `spawn-ledger.json`（`LEDGER_FILENAME`）里登记过的 spawn 记录，逐条 `probe_kernel` 探活：能连就 attach 复用，进程已死的条目顺手清掉，不重复起第二个内核。
  - 复用不到才 `spawn <hermes> serve --host 127.0.0.1 --port 0`，端口交给内核自己选，壳不写死；从 stdout 等 `HERMES_BACKEND_READY` 拿端口，再做 token 握手（从日志里取 `__HERMES_SESSION_TOKEN__`）。就绪超时 60 s，探测超时 15 s。
  - 自己拉起来的进程（`Ownership::Spawned`）挂了按 `MAX_RESTARTS = 3` 退避重启；attach 来的不重启、不杀。退出时 `shutdown_owned_kernel()` 只收自己的进程。
  - 二进制查找顺序：`HERMES_KERNEL_BIN` → `<root>/hermes-agent/.hermes/bin/hermes(.exe)` → `<root>/bin/hermes(.exe)` → `PATH`。找不到就报「找不到 hermes 可执行文件（可设置 HERMES_KERNEL_BIN）」。
- `bootstrap.rs` —— `local` 模式走上面这套托管，托管失败就退回 `connection.json` 里配置的地址并标 `degraded`（界面还能起来，给重试）；`remote` 模式只 attach，不托管。
- `commands/ws_proxy.rs` —— `/api/ws` 转发。打包后的 webview 可能因 `tauri://` origin 拒绝连 `ws://127.0.0.1`，所以由 Rust 侧开这条官方 JSON-RPC socket，再把帧以 `gateway-ws-message` / `gateway-ws-closed` 事件转给前端。内核看到的始终是一个标准官方 WS 客户端，session token 不落到 webview 的 URL 上。JS 侧对应 `web/src/lib/gateway-relay-socket.ts`。
- `commands/api_proxy.rs` —— HTTP 代理（`api_request` / `external_request` / `upload_file`）：本地拦截会话日志、归档、运行时更新等路由，其余带 auth header 转发给内核。
- 其余：`connection.rs` 连接配置、`tray.rs` 托盘、`session_log.rs` / `session_archive.rs` 会话日志与归档、`environment.rs` 环境自检，`commands/` 下另有 20 多个模块。
- Cargo feature `embedded-python`（pyo3）默认关闭，默认构建走外部 `hermes` 二进制。

### React 前端（`web/src`）

- `routes/detail.tsx` —— 会话页，消息、输入框、纠错、审批的编排都在这里。
- `components/chat/` —— `message-timeline.tsx`（时间线 + 滚动守卫 + 回底）、`markdown-renderer.tsx`、`tool-result-card.tsx`、`goose-composer.tsx`（输入框）、`inline-prompt-card.tsx`（审批 / 追问）、`delegate-run-card.tsx` + `subagent-panel.tsx`（子代理）。
- `hooks/` —— `use-session-messages.ts` 分页取数、`use-stall-watchdog.ts` 卡死检测、`use-gateway.ts` 网关状态。
- `lib/gateway-client.ts` —— WS JSON-RPC 客户端（退避重连、唤醒重连、`session.resume`、补帧）。
- 状态：TanStack Query 管服务端数据，Jotai 管本地 UI 状态。

### 协议包（`packages/*`）

- `packages/protocol` —— `hermes-api.ts`（内核 REST 响应的 zod schema）、`channels.ts`（事件通道）、`session-log.ts`（把磁盘 `session_*.json` 转成消息模型）。前端和 Vite dev 中间件共用，改 schema 只改这里。
- `packages/shared-ui` —— 设计 token 与通用组件；`node scripts/check-4px-grid.mjs` 校验 4px 栅格。

## 对话层能力

| 能力 | 实现位置 | 要点 |
|---|---|---|
| 代码高亮 | `web/src/components/chat/markdown-renderer.tsx`、`web/vite.config.ts` | shiki 走 `import("@streamdown/code")` 惰性加载，没有代码块就不下载；`manualChunks` 把它单独拆成 `vendor-shiki`（`langs` / `themes` 刻意不拆，保持按需）。带结果缓存和流式节流 |
| 工具结果结构化卡 | `web/src/lib/tool-result-view.ts`、`web/src/components/chat/tool-result-card.tsx` | 按工具名分三类：终端转录（命令 / cwd / stdout / stderr / exit，可整段复制）、自写的行级 diff（`DiffRow`，带加删统计，结构化上限 2000 行、渲染上限 500 行，超出标 truncated）、其余归为 json/raw 可复制文本。不把原始 JSON 直接怼给用户 |
| 服务端分页 | `web/src/hooks/use-session-messages.ts` | `order=latest` + `limit` / `offset`；首屏 100 条（`SESSION_MESSAGES_PAGE_SIZE`），单页上限 500；`loadEarlier()` 拿已加载条数当 offset 续取；`hasMore = !reachedStart`，而 `reachedStart = returned < limit` —— 内核 messages 端点没有 `has_more` 字段，只能这么判。staleTime 30 s |
| 编辑并重发 / 重试 | `web/src/routes/detail.tsx`、`web/src/components/chat/confirm-truncate-dialog.tsx` | 走内核 `prompt.submit` 的 `truncate_before_row_id` + `confirm_truncate: true`，是真截断（后面轮次会被删）。发送前按本地时间线算「会删掉几条」，弹一次确认，各入口共用。内核不支持该方法时直接走旧路径，不弹框 |
| 运行中「引导」 | `web/src/components/chat/goose-composer.tsx` | 回合进行中 Enter 变 `session.steer`：`redirected` 提示「已改为当前轮的新指令」，其余提示「已并入当前轮」；`unsupported-method`、code `4010` 或文案匹配到不支持 → 记住不再试，降级成排队（「当前内核不支持实时引导，已改为排队」）。附件 / Skill 塞不进一句纯文本，直接排队 |
| 子代理插话 | `web/src/components/chat/delegate-run-card.tsx` | `subagent.steer`（`session_id` + `subagent_id` + `text`）。`status: rejected` 提示「子代理已不接受插话」，成功提示「已排队，子代理下个批次会看到」 |
| 回到底部 + 未读计数 | `web/src/components/chat/message-timeline.tsx` | `button[aria-label^="回到底部"]`，有未读时文案是「回到底部 · 下面还有 N 条」。位置在 `message-timeline.module.css` 里写死 `bottom: 22px` |
| 复制只取正文 | `web/src/components/chat/message-timeline.tsx` 的 `copyableMessageText()` | 只拼 `type === "text"` 的 block，推理、工具卡、附件都不进剪贴板 |
| 相对时间 | 同上 `MessageTimeLabel` / `formatMessageTime` | 一分钟内「刚刚」，一小时内「N 分钟前」，跨小时或跨天显示时刻，定时器刷新 |
| 图片看大图 | `web/src/components/chat/zoomable-image.tsx` | portal 覆盖层，0.5–8 倍、滚轮/按钮缩放、拖动平移，3 px 阈值区分点击和拖拽 |
| 大粘贴转附件 | `web/src/components/chat/goose-composer-attachments.tsx` | 超过 `LARGE_PASTE_ATTACHMENT_THRESHOLD = 3000` 字的粘贴转成 `.txt` 附件，提示「已粘入的 N 字已转为附件」；单附件上限 50 MB |
| 拖拽进输入框 | `web/src/components/chat/goose-composer.tsx` 的 `handleDrop` | 认 `Files` / `text/plain` / `text/uri-list`：文件按路径挂附件，文本插进输入框 |
| 方法不支持降级 | `web/src/lib/gateway-result.ts`、`web/src/lib/gateway-capabilities.ts` | `classifyGatewayError()` 把任意网关错误归成 `unsupported-method` / `auth` / `not-found` / `timeout` / `network` / `server` / `unknown` 七类，zod 报错和英文传输错误在展示边界换成中文；`gateway-capabilities.ts` 在本次连接内记住被判为不支持的方法，不再重复打网关（命中时错误文案与首次一致），重连 / 换内核后由 `GatewayClient` 调 `forgetGatewayCapabilities()` 重置 |

## 稳定性设计

这些大多是被实际故障逼出来的，改动时别顺手删。

- **卡死看门狗**（`web/src/hooks/use-stall-watchdog.ts`、`web/src/lib/session-activity.ts`、`components/chat/stall-notice.tsx`）：WS 心跳只证明 socket 活着 —— 模型供应商挂死时内核照样回 pong，回合耗时能一直跳。看门狗单独盯「这个回合多久没收到任何后端事件」，超过 `STALL_WATCHDOG_THRESHOLD_MS = 90_000` 翻 `isStalled`，给提示和中断/重试；任何后端事件到达就自己清零。每 2 s 评估一次，只依赖 `lastActivityAt` / `turnStartedAt`，不在每个 token 上重排定时器。
- **程序跳转滚动守卫**（`message-timeline.tsx`）：平滑滚到某一轮会让 `scrollTop` 递减，`onScroll` 很容易把它误判成「用户上滑」从而取消贴底跟随，把自己的动画打断。用标记把程序滚动和用户手势分开，到达目标后解除；用户真滚轮/拖动时仍可夺回控制。
- **审批手势 + 中文提示**（`components/chat/inline-prompt-card.tsx`）：左滑拒绝、右滑允许一次；键盘 1–9 选选项、Enter 提交、Esc 关；「始终允许」要再点一次确认，并写明会写入 `~/.hermes/config.yaml` 的 allowlist。审批文案全中文，不露英文枚举。
- **重连补帧去重**（`web/src/lib/gateway-replay.ts`、`gateway-reconnect.ts`）：重连后用**一次** `session.resume` 决定补帧还是快照 —— 水位可信就按本地 seq 用 `session.events.since` 补帧，水位不可信（超前 / epoch 变 / seq 缺口 / truncated）就用这次 resume 返回的 messages 覆盖时间线。旧实现两次 resume 会在内核重启时引发会话归属竞态和 `open_requests` 重投，源码注释里写清了为什么不能拆开。
- **内核端口回退提示条**（`components/app-shell/kernel-port-fallback-notice.tsx`、`lib/kernel-status.ts` 的 `isKernelPortFallback`）：重启内核后旧端口没抢回来、内核跑到新端口时，WS 通道会一直连不上。这时明确告知「网络通道需要重启桌面端才能恢复」+ 当前地址可复制 + 重试，而不是让用户对着转圈猜。
- **托管失败降级**（`bootstrap.rs`）：本机内核起不来先退到配置地址，还不行就标 `degraded` 并让界面起来报错，不白屏。

## 开发

前置：Rust stable、Node 20+、pnpm 9.15（`packageManager` 已锁，`preinstall` 会拦住非 pnpm）。

```bash
pnpm install --frozen-lockfile

pnpm dev          # 只跑前端（vite，localhost:9545），要连一个已在跑的内核
pnpm tauri:dev    # 完整桌面壳，内部会先 version:sync
pnpm web:build    # 只构建前端产物到 web/dist

pnpm typecheck    # license:check + version:check + 4px 栅格 + 全 workspace tsc --noEmit
pnpm test:unit    # 各 workspace 的 vitest，串行跑
```

- 单独跑前端测试：`cd web && npx vitest run`（或 `pnpm --filter @hermes/web test:unit`）；单独跑类型：`cd web && npx tsc --noEmit`。
- Rust 侧：`cargo run` 起壳，`cargo test` 跑 `tests/` 下的集成测试。
- `9545` 被 Windows 保留端口段（Hyper-V / WSL2 常见）占掉时，`web/vite.config.ts` 的 `resolveDevServerPort()` 会自动换一个空闲端口；但 `tauri dev` 下 `devUrl` 写死 `http://localhost:9545`，所以那时不探测、直接报错。
- 打包会重编整个 crate（`web/dist` 是编译输入），只改前端也要等编译。Rust 侧文案建议攒一次改完。

## 测试基线

`web/` 下 `npx vitest run` 实测（本轮改 README 时跑的）：

```text
Test Files  255 passed | 1 skipped (256)
     Tests  2487 passed | 2 skipped (2490)
  Duration  105.79s
```

数字会随改动变，别当常量去对；跑挂了先看是不是守卫被顺手删了 —— 滚动守卫、审批二次确认、`hasMore` 的 UI 消费方是高频回归点。

## 版本与发布

- 版本号唯一真相是根 `package.json`，格式 `0.8.0-rcNN`，每发一版 rc 递增（文档里不硬编码具体 rc 号）。
- `pnpm version:sync`（`node scripts/sync-desktop-version.mjs`）把版本传播到 `web/package.json`、`packages/*/package.json`、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock` 和相关文档；`pnpm version:check` 只校验不改，已包含在 `pnpm typecheck` 里。
- 构建：`pnpm tauri:build`（先 `license:sync`，再 `version:sync`，然后 `tauri build --bundles nsis`）。
- 产物：`target/release/bundle/nsis/Hermes Agent CN Desktop_<version>_x64-setup.exe`。bundle identifier `cn.org.hermesagent.desktop` 是升级安全的承重标识，不要改。
- 自动更新链路已移除，上游发新版不会自己装回来，需要人工合并（步骤见 FORK-NOTES.md）。

## 已知限制

- **跨应用拖文本不可靠**：`handleDrop` 只处理 `Files` / `text/plain` / `text/uri-list`。Windows 上不少原生程序拖出来只带文件（CF_HDROP），拿不到 `text/plain`，于是被当成文件路径或直接忽略。从浏览器、编辑器拖文本正常。
- **内核 messages 端点没有 `has_more`**，翻页只能靠 `returned < limit` 判到底；内核若改了默认页大小，这里的判断要跟着改。
- **回底按钮位置写死** `bottom: 22px`（`message-timeline.module.css`），底部再加浮层时要手动挪。
- **编辑重发依赖 `prompt.submit` 的 `truncate_before_row_id`**，旧内核不支持时不截断、退回普通发送，历史不会真的删掉。
- **托管内核只管本机回环**：`ensure_kernel` 收到远端地址会直接返回错误（「远程模式优先，跳过本机内核管理」），远端是 attach-only。
- 根布局而非 `src-tauri/`，外部脚本、CI 模板、Tauri 文档命令按默认布局找都会失败。

## 仓库结构

```text
├── src/          Rust：内核托管、代理、Tauri commands
├── web/          React：Vite + TanStack Query + Jotai
├── packages/     protocol（IPC 契约）、shared-ui（设计 token）
├── e2e/          Playwright 端到端
├── tests/        Rust 集成测试
├── scripts/      版本同步、许可证、4px 栅格校验、dev 启动器
├── tauri.conf.json / Cargo.toml / target/   都在仓库根
└── docs/         设计稿与专题说明
```

## 许可

本项目的非商业使用遵守 [PolyForm Noncommercial License 1.0.0](./LICENSE)。商业使用、商业分发、商业集成、托管销售或作为商业产品组成部分使用，需提前获得青岛万德缦思网络科技有限公司的单独商业授权；授权联系邮箱：lijiale@wanderminds.cn。

原项目版权归 [Eynzof](https://github.com/Eynzof) 所有。
