# FORK-NOTES.md —— 本 fork 的源码精简记录

上游：`Eynzof/Hermes-CN-Desktop`，基线 commit `06e15d0e5d3c27f1fd37f09579f26f91c020036e`（2026-09-20，v0.9.0）。

本 fork 只做**减法**：删品牌推广、删返利链接、删遥测、删冗余视觉元素、删人格市场。
不改任何功能逻辑，不改后端契约，不改 Tauri 配置。

**自动更新：已移除。** 上游发新版不会自动装回来，需要人工按下面的步骤合并。

---

## 一、已做的改动（逐条，含位置）

### A. 品牌区

| # | 文件 | 改动 |
|---|---|---|
| 1 | `web/src/components/app-shell/app-top-bar.tsx` | 删 `BRAND_URL`、`openBrandSite`、`openExternalUrl`/`build-info` 导入；顶部品牌从 `<a href=hermesagent.org.cn>` 改为不可点的 `<div>`；删 `brandMeta`（「中文社区桌面版 · hermesagent.org.cn」）；删导航 `navNum`（01–05 编号） |
| 2 | `web/src/components/sidebar/sidebar.tsx` | 删品牌条下的 `brandSub`（「中文社区桌面版」） |
| 3 | `web/src/lib/tauri-bridge.ts` | 启动屏文案 `Hermes Agent 中文社区桌面版` → `Hermes Agent`；`Hermes Agent 中文社区 · hermesagent.org.cn` → `Hermes Agent` |
| 4 | 全库 9 处 | `中文社区桌面版` → `Hermes Agent`：`gateway-sidebar.tsx`(title×2)、`hermes-logo-mark.tsx`(注释)、`debug.tsx`(排障包)、`guide.tsx`、`im-onboarding.tsx`、`settings.tsx`(内核 eyebrow) |

### B. 推广 / 返利

| # | 文件 | 改动 |
|---|---|---|
| 5 | `web/src/lib/provider-catalog.ts` | 删 **11 处** `promotion` 块：优云智算 `cp.compshare.cn`、`modelverse`（同一 `referral_code=K50gMvv85OmEJ5T9ZDUtDE`），以及 packycode、ccsub、apikey.fun、aigocode、right.codes、aicodemirror、sssaicode、micuapi、nekocode、cubence 十家中转站的邀请码 |
| 6 | `web/src/lib/provider-catalog.ts` | 删 `normalizeRemotePromotion()`、`PROMOTION_BADGES`、`normalizeRemoteProvider` 里的 promotion 透传 —— **远端下发的推广徽章和邀请链接现在一律被丢弃** |
| 7 | `web/src/routes/guide.tsx` | 删 `<aside className={s.support}>` 整块：微信群二维码、`HeartHandshake`、「来中文社区问我们」、「打开官网」按钮 |
| 8 | `web/src/routes/offline-shell.tsx` | 删「中文社区官网」卡片（含跳 `hermesagent.org.cn` 的按钮） |
| 9 | `web/src/routes/settings.tsx` | 删「联系方式」整张 DebugCard：官网链接、两个 issue 仓库入口、`hello@wanderminds.ai` 商务合作、微信/飞书群二维码 |
| 10 | `web/src/routes/settings.tsx` | 删「致谢与许可」里的优云智算赞助段落（保留 Nous Research 与字体许可署名） |
| 11 | `web/src/routes/skills.tsx` | `由 Hermes 中文社区维护翻译` → `已提供中文翻译` |

### C. 遥测 / 自动更新

| # | 文件 | 改动 |
|---|---|---|
| 12 | `web/src/app.tsx` | 删 `DesktopUpdateNotifier` 的 import 和挂载 —— 不再检查更新、不弹更新框 |
| 13 | `web/src/app.tsx` | 删启动遥测 `useEffect`：`sendTelemetryPingIfDue()` + `sendTokenUsageTelemetryIfDue()` —— 不再向 `desktop.hermesagent.org.cn/api/telemetry` 上报 |

> `web/src/lib/telemetry.ts`、`web/src/lib/desktop-update.ts`、`web/src/components/desktop-update-notifier.tsx` 文件本身**保留**（无引用即不打进产物），这样上游合并时冲突面最小。

### D. 冗余视觉元素

| # | 文件 | 改动 |
|---|---|---|
| 14 | 8 个侧栏组件 | 删全部 `✕✕` 占位符（`s.labelNum`）11 处：advanced / automation / capability / external-memory / gateway / observability / wander-memory / workbench |
| 15 | `capability-sidebar.tsx`(×3)、`gateway-sidebar.tsx`、`advanced-sidebar.tsx`(×2) | 分组标签去掉 `§0xx · ` 前缀 |
| 16 | `automation-sidebar.tsx`、`observability-sidebar.tsx`、`external-memory-sidebar.tsx`、`wander-memory-sidebar.tsx` | JSX 里的 `§0x · ` 前缀 |
| 17 | `placeholder-sidebar.tsx` | `` `§ ${def.num} · ${def.label}` `` → `def.label`；`"§ —"` → `"—"` |
| 18 | `workbench-sidebar.tsx` | `sectionLabel()` 不再拼 `§NN · `，直接返回 label |
| 26 | `web/src/routes/panel.module.css` | `.section` 的 `grid-template-columns: 64px 1fr` → `1fr`（`§` 编号删掉后左边留了 64px 空列，工作台各区块整体右移） |
| 27 | `web/src/components/panel/panel-hero.tsx` + `panel-hero.module.css` | 删 hero 左上角竖排装饰 `NO. 001 / 工作台`，`.hero` 的 `64px 1fr` → `1fr`（同一类空槽） |

### F. Rust 侧窗口标题（前端改不到，必须改 Rust）
| # | 文件 | 改动 |
|---|---|---|
| 23 | `src/main.rs` | `WindowBuilder.title("Hermes Agent 中文社区桌面版")` → `"Hermes Agent"`；连带把文件头注释、`bootstrapping` 日志、`.expect()` 文案里的「中文社区桌面版」去掉 |
| 24 | `src/tray.rs` | 托盘 `.tooltip("Hermes Agent 中文社区桌面版")` → `"Hermes Agent"` |
| 25 | `src/bootstrap.rs` | 两处 `log::info!` 文案去掉「中文社区桌面版」 |

### E. 体积

| # | 路径 | 改动 |
|---|---|---|
| 19 | `web/src/data/persona-market/`（3.2 MB：`personas.generated.ts` + 215 个 prompt md） | 整目录删除 |
| 20 | `web/src/components/persona/`（28 KB） | 整目录删除 |
| 21 | `web/src/lib/persona-market.ts` + `.test.ts` | 删除 |
| 22 | `web/src/routes/soul.tsx` | 删「人格市场 / 自定义人格」两个 tab 和 `PersonaMarketPanel` 分支，只保留 Hermes 人格编辑器；连带删 `page`/`setPage`、`handleApplyPersona`、`Store`/`UserRound` 图标导入 |

**效果**：前端 chunk 307 → 92，`web/dist` 17 MB。

---

## 二、上游更新怎么合（给 AI 的步骤）

```bash
cd D:/OpenSource/hermes-cn-desktop
git remote add upstream https://github.com/Eynzof/Hermes-CN-Desktop.git   # 只做一次
git fetch upstream --tags
git log --oneline HEAD..upstream/main | head -40        # 先看清上游改了什么
git diff --stat HEAD..upstream/main -- web/src | tail -20
```

合并策略：**逐条重放，不要整文件覆盖。**

1. 优先 `git merge upstream/main`，让 git 标冲突。
2. 冲突文件按本文档「一、已做的改动」逐条重放；**本文档里没有的文件一律取上游版本**。
3. 以下文件是热点，上游几乎必改，冲突概率最高，合并后必须回归：
   - `web/src/components/app-shell/app-top-bar.tsx`
   - `web/src/lib/provider-catalog.ts`（尤其 `normalizeRemoteProvider` 和 BUILTIN catalog）
   - `web/src/app.tsx`
   - `web/src/routes/soul.tsx`、`web/src/routes/settings.tsx`
4. 合并后必跑的回归检查（缺一不可）：

```bash
# 推广字段必须为 0
grep -rn "promotion:" web/src/lib/provider-catalog.ts | wc -l          # 期望 0
# 品牌与社区推广必须为 0
grep -rn "中文社区\|hermesagent.org.cn" web/src --include=*.ts --include=*.tsx | grep -v "\.test\." | wc -l   # 期望 0
# 遥测与更新检查不得挂载
grep -n "sendTelemetryPingIfDue\|DesktopUpdateNotifier />" web/src/app.tsx | wc -l   # 期望 0
# 视觉冗余必须为 0
grep -rn "✕✕" web/src --include=*.tsx | wc -l                          # 期望 0
# 人格市场目录必须不存在
ls web/src/data/persona-market 2>/dev/null | wc -l                    # 期望 0
```

5. 构建验证：

```bash
pnpm install --frozen-lockfile
pnpm run web:build:desktop          # 期望 "✓ built in ...s"，无 error
```

6. 若上游新增了带邀请码的 provider，编号 5 的处理方式照抄：删 `promotion` 整块，保留 provider 本身。

---

## 三、构建完整安装包（Windows）

前置二选一，缺一不可：

**A. 内核源码仓**（`bundle:stage-windows` 要用它取 skills / plugins / dashboard）：

```bash
git clone --depth 1 https://github.com/Eynzof/Hermes-CN-Core.git D:/OpenSource/Hermes-CN-Core
# dashboard 的 web_dist 不必 npm build：runtime zip 里自带
#   _internal/hermes_cli/web_dist/  → 解压到 <core>/hermes_cli/web_dist/ 即可
export HERMES_AGENT_CN_SOURCE=D:/OpenSource/Hermes-CN-Core
```

**B. 工具链**：Rust（MSVC 工具链）+ Visual Studio Build Tools（C++ 桌面开发 + Windows SDK 10）。

> 本机 rustup 是 `--no-modify-path` 装的，PATH 里没有 `~/.cargo/bin`。每次构建前先 `export PATH="$HOME/.cargo/bin:$PATH"`，否则 `pnpm exec tauri build` 找不到 cargo。

```bash
pnpm install --frozen-lockfile
pnpm run tauri:build:bundled-windows
# 只改了 Rust/前端、静态资源没动时的增量包：
pnpm exec tauri build --bundles nsis
```

产物：`target/release/bundle/nsis/Hermes Agent CN Desktop_<ver>_x64-setup.exe`（本机实测 183,540,681 字节，NotSigned）。
主程序：`target/release/hermes-agent-cn-desktop.exe`（35,708,416 字节）。

---

## 四、明确**没有**改动的东西

- 后端 Rust 代码（`src/`）、`tauri.conf.json`、端口占用、连接模式（managed/local/remote）
- 打包与 runtime staging 脚本（`scripts/`）
- 任何 provider 的 `baseUrl` / `apiKeyLabel` / 模型列表
- 飞书、微信网关接入功能（`IM_ITEMS` 只有 2 项，没有 16 个入口可删）
- 主题系统、命令面板、Kanban、Skills 等功能页

---

## 五、试过但**走不通**的路：换内核（2026-10-21 实测，已回滚）

目标：把 CN 自带的 252 MB Python 内核换成官方 Hermes 内核，或让 CN 只当壳、连本机官方 dashboard。

### 5.1 让 CN 壳直接拉官方 exe —— 失败

源码上完全许可：`src/process/dashboard.rs:949` 只读 `data/current.json` 的 `executablePath`，不校验版本/flavor/签名；`src/bootstrap.rs:160` 只在 `current.json` **不存在**时才装 runtime，所以手改不会被覆盖。

实测步骤：把 `executablePath` 改成 `C:\\Users\\<user>\\AppData\\Local\\hermes\\bin\\hermes.exe`，重启。

结果：`Dashboard startup failed: ... after 3 attempt(s) on ports [9120, 9121, 9122] — last failure: dashboard exited before ready (exit code: 1)`。

官方内核确实启动了（`<CN>/data/hermes-home/logs/errors.log` 里有它加载 memory provider 的记录），然后在 06 秒后静默退出，没有 Traceback。根因在 CN 塞给子进程的这套 env（`dashboard.rs:1041-1100`）：`HERMES_HOME` 指向 CN 的空 home（`config_version 34`，官方是 51）、`HERMES_WEB_DIST` 指向 CN 的 `web_dist`、`HERMES_BUNDLED_SKILLS/_PLUGINS` 是 CN 的目录，加上官方内核自己的插件加载失败。逐项调通成本高于收益。

回滚：`cp data/current.json.bak-<ts> data/current.json` + 重启，恢复原状。

### 5.2 CN 走 local 模式连本机官方 dashboard —— 也失败

`connection.rs:504-510` 的 local 模式是一个 HTTP 代理（`ConnectionBackend::Local(LocalBackend{base_url})`），数据文件里只有 `{"version":3,"mode":"local","local":{"url":"..."}}`，**没有 token 字段**。

而官方 dashboard 对 `/api/*` 强制要求 token：`hermes_cli/web_server.py:305-316` 校验 `X-Hermes-Session-Token` 头或 `Authorization: Bearer`，token 来自 `HERMES_DASHBOARD_SESSION_TOKEN`，否则每次启动随机生成并只注入 SPA HTML。实测：9119 上起官方 dashboard，`/api/status` 200，`/api/sessions` 一直 401（不带 token、带 cookie、带错误 Bearer 都 401）。即使加 `HERMES_DESKTOP=1` + token 重启也一样，因为 token 值不匹配。

结论：这条路要通，必须给 CN 的 `LocalBackend` 加一个 token header（改 Rust 重编译），或改官方 dashboard 放行 loopback 无 token 请求。两者都不是配置层面能解决的。

### 5.3 官方内核报告 `version: "unknown"`

用 `venv\Scripts\hermes.exe` 起的内核，`/api/status` 返回：

```json
{"version":"unknown","release_date":"2026.9.24","config_version":34,...}
```

venv 安装没有 PyInstaller 的 build 元数据，所以版本号解析不出来。即使 `/api/version` 的 404 被放过，`verifyBackendVersion` 还会拿 `unknown` 跟期望版本比，走 `mismatch` 分支，同样致命。要接官方内核，版本校验这一关必须整体改成「后端自带版本则比、不自带则放行」。

### 5.4 一句话

CN 的内核不是「可以顺手替换的组件」，它是这个壳的运行时契约（端口、token、home、web_dist、插件目录全套绑死）。想用官方内核，正确做法是用官方 desktop，而不是给 CN 壳换心脏。
