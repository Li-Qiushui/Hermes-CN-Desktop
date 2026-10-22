// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/api-docs.tsx — #/wander-memory/api: the HTTP/WebSocket
// API reference and the backend-connection guide, rendered in-app. Ported from
// WanderMemory `web/app/src/views/ApiDocsView.tsx` (content sourced from
// `docs/memory_api.md` §3–§4). Static component — no data fetching.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Badge, CopyButton } from "@hermes/shared-ui";
import {
  WanderMemoryLayout,
  WanderMemorySection,
} from "@/components/wander-memory/layout";
import s from "./api-docs.module.css";

type RestMethod = "GET" | "POST" | "DELETE";

interface RestRow {
  method: RestMethod;
  path: string;
  body?: string;
  returns: string;
  llm?: boolean;
  notes?: string;
}

const REST_ROWS: RestRow[] = [
  {
    method: "GET",
    path: "/v1/health",
    returns: '{ status: "ok", backends: Record<string, boolean>, model: string, backend?: string }',
    notes: "远程模式或探测失败时 backends 为 {}；backend（client_type）仅远程模式出现",
  },
  {
    method: "GET",
    path: "/v1/backends",
    returns: "{ devices: [{ backend, index, name, total_mib }], remote?: boolean }",
    notes: "远程模式下 devices 为 [] 且 remote: true",
  },
  { method: "GET", path: "/v1/models", returns: "{ model: string, reasoning: string }", notes: 'reasoning 预期为 "off"' },
  {
    method: "POST",
    path: "/v1/dialogues",
    body: "{ dialogue: string }",
    returns: "{ stored: MemoryItem[], collisions: CollisionSummary[], total: number }",
    llm: true,
    notes: "collisions[] 与 stored[] 按顺序一一对应；dialogue 也可为 {role, content} 数组的 JSON 字符串",
  },
  {
    method: "POST",
    path: "/v1/memories",
    body: "{ text: string, metadata?: object }",
    returns: "{ memory: MemoryItem, collision: CollisionSummary }",
    llm: true,
    notes: "collision 始终存在",
  },
  {
    method: "GET",
    path: "/v1/memories?q=&top_k=",
    returns: "{ results: MemoryItem[] }",
    notes: "不传 q 返回全量；不传 top_k 用服务端默认值",
  },
  { method: "GET", path: "/v1/memories/{id}", returns: "{ memory: MemoryItem }", notes: "不存在时返回 404 not_found" },
  { method: "DELETE", path: "/v1/memories/{id}", returns: "204 No Content（空响应体）", notes: "不存在时返回 404 not_found" },
  {
    method: "POST",
    path: "/v1/context",
    body: "{ query: string, top_k?: number }",
    returns: "{ context: string }",
    notes: "无匹配时返回空字符串",
  },
  {
    method: "POST",
    path: "/v1/chat",
    body: "{ query: string }",
    returns: "{ reply: string }",
    llm: true,
    notes: "非流式；需要增量请用 WS chat 并设 stream: true",
  },
  { method: "POST", path: "/v1/maintenance", returns: "{ total: number, errors: string[] }" },
];

interface WsOpRow {
  op: string;
  payload: string;
  result: string;
  notes?: string;
}

const WS_OPS_ROWS: WsOpRow[] = [
  { op: "health", payload: "{}", result: "HealthResponse" },
  { op: "models", payload: "{}", result: "ModelsResponse" },
  { op: "backends.list", payload: "{}", result: "BackendsResponse" },
  { op: "memories.add", payload: "{ text, metadata? }", result: "AddMemoryResponse" },
  { op: "memories.search", payload: "{ query, top_k? }", result: "{ results }" },
  { op: "memories.list", payload: "{}", result: "{ results }" },
  { op: "memories.get", payload: "{ id }", result: "{ memory }", notes: "id 是载荷字段，不是路径片段" },
  { op: "memories.delete", payload: "{ id }", result: "null" },
  { op: "dialogues.add", payload: "{ dialogue }", result: "AddDialogueResponse" },
  { op: "context.build", payload: "{ query, top_k? }", result: "{ context }" },
  { op: "chat", payload: "{ query, stream: true }", result: "先 delta* 帧，最后 done { reply }", notes: "不传 stream 则只返回单个结果帧" },
  { op: "maintenance.run", payload: "{}", result: "{ total, errors }" },
];

interface ErrorRow {
  code: string;
  http: string;
  meaning: string;
}

const ERROR_ROWS: ErrorRow[] = [
  { code: "bad_request", http: "400", meaning: "请求体格式错误 / 校验失败" },
  { code: "not_found", http: "404", meaning: "没有该 id 对应的记忆" },
  { code: "unknown_op", http: "400", meaning: "WS 操作不在文档词表内 — 客户端缺陷" },
  { code: "conflict", http: "409", meaning: "记忆系统尚未启动" },
  { code: "collision_conflict", http: "409", meaning: "并发写入 — 请重试" },
  { code: "llm_unavailable", http: "503", meaning: "LLM 服务不可达；在健康恢复前 chat/dialogue 都会失败" },
  { code: "backend_probe_failed", http: "503", meaning: "设备探测失败（不阻塞）" },
  { code: "collision_parse_failed", http: "502", meaning: "失败即封闭：记忆未被存储" },
  { code: "collision_validation_failed", http: "502", meaning: "失败即封闭：记忆未被存储" },
  { code: "collision_apply_failed", http: "500", meaning: "失败即封闭：存储回滚到操作前状态" },
  { code: "internal", http: "500", meaning: "服务端意外错误" },
];

const TYPES_SNIPPET = `interface MemoryItem {
  id: string;
  memory: string;
  metadata: Record<string, unknown>;
}

// ALWAYS present on write responses
interface CollisionSummary {
  deleted: number;
  merged: number;
  stored_new: boolean;
  reason: string;
}

// error convention — every non-2xx response
interface ApiErrorBody { error: { code: string; message: string } }`;

const WS_SNIPPET = `// request
{ "id": 1, "op": "chat", "payload": { "query": "…", "stream": true } }

// frames
{ "id": 1, "ok": true, "type": "delta", "delta": "Based on" }
{ "id": 1, "ok": true, "type": "done",  "result": { "reply": "…" } }
{ "id": 1, "ok": true, "result": { … } } // non-streaming ops
{ "id": 1, "ok": false, "error": { "code": "…", "message": "…" } }

// keepalive
→ { "type": "ping" } // client, every 25 s
← { "id": null, "type": "pong", "ts": 1754… }`;

const CURL_SNIPPET = `# health
curl http://127.0.0.1:18400/v1/health

# add a memory (collision summary is always present)
curl -X POST http://127.0.0.1:18400/v1/memories \\
  -H 'Content-Type: application/json' \\
  -d '{"text": "The user is allergic to peanuts", "metadata": {"type": "fact"}}'

# search (CJK-safe — always URL-encode)
curl 'http://127.0.0.1:18400/v1/memories?q=%E8%8A%B1%E7%94%9F&top_k=5'

# import a dialogue (LLM path — allow generous timeouts)
curl -X POST http://127.0.0.1:18400/v1/dialogues \\
  -H 'Content-Type: application/json' \\
  -d '{"dialogue": "user: 我对花生过敏\\nassistant: 已记下"}'

# streaming chat over WebSocket (port 18401)
websocat ws://127.0.0.1:18401/v1/ws
> {"id": 1, "op": "chat", "payload": {"query": "what food must I avoid?", "stream": true}}`;

const BACKEND_SNIPPET = `# production: the API server itself hosts this SPA from web/dist
uv run python -m src.memory --model models/Qwen3.5-9B --device CUDA0 \\
    --web-dir web/dist
# → open http://127.0.0.1:18400/app/ (REST + static same-origin, no CORS)

# development: Vite dev server proxies REST; WS connects direct
# vite.config.ts:
# server: { proxy: { "/v1": "http://127.0.0.1:18400" } }
# base: "/app/" # matches static_prefix on the server
npm run dev # http://127.0.0.1:5173 → /v1 proxied to :18400
                      # ws://127.0.0.1:18401/v1/ws used directly (no proxy)`;

const PYTHON_SNIPPET = `# src/memory/api.py — additive serving changes (off by default)
MemoryAPIServer(
    ...,
    static_dir: Path | None = None, # e.g. Path("web/dist")
    static_prefix: str = "/app", # /v1 keeps routing priority
    cors_origins: list[str] | None = None,  # dev-only; default off
)

# static serving rules:
# GET /app/* → files under static_dir (path-traversal guarded)
# GET /app, /app/ → index.html
# GET / → 302 → /app/
# Cache-Control: no-cache for HTML; max-age=31536000, immutable
# for Vite's fingerprinted assets
#
# CORS (only when cors_origins is set): echo matched origin,
# allow GET/POST/DELETE/OPTIONS + Content-Type, answer preflight 204.`;

function MethodBadge({ m }: { m: RestMethod }) {
  const tone = m === "GET" ? "success" : m === "POST" ? "warning" : "danger";
  return (
    <Badge tone={tone} variant="outline" size="sm">
      {m}
    </Badge>
  );
}

function CodeBlock({ code, title }: { code: string; title?: string }) {
  return (
    <div className={s.codeBlock}>
      <div className={s.codeHead}>
        <span className={s.codeTitle}>{title ?? "代码"}</span>
        <CopyButton text={code} variant="plain" size="xs" copiedLabel="已复制">
          复制
        </CopyButton>
      </div>
      <pre className={s.codeText}>{code}</pre>
    </div>
  );
}

type DocsTab = "rest" | "ws" | "connect";

function ApiDocsPage() {
  const [tab, setTab] = useState<DocsTab>("rest");

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.pageHead}>
        <div>
          <h1 className={s.pageTitle}>记忆服务 API</h1>
          <p className={s.pageSub}>
            REST http://127.0.0.1:18400/v1 · WebSocket ws://127.0.0.1:18401/v1/ws · 单用户，仅监听回环地址
          </p>
        </div>
        <div className={s.tabs} role="tablist" aria-label="API 参考章节">
          {(["rest", "ws", "connect"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              data-active={tab === t ? "true" : undefined}
              onClick={() => setTab(t)}
              className={s.tab}
            >
              {t === "rest" ? "REST 参考" : t === "ws" ? "WebSocket 协议" : "连接后端"}
            </button>
          ))}
        </div>
      </div>

      {tab === "rest" ? (
        <div className={s.sections}>
          <WanderMemorySection title="公共类型">
            <CodeBlock code={TYPES_SNIPPET} title="类型（§3.1、§4.1）" />
          </WanderMemorySection>

          <WanderMemorySection title="接口列表">
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th className={s.th}>方法</th>
                    <th className={s.th}>路径</th>
                    <th className={s.th}>请求体</th>
                    <th className={s.th}>返回</th>
                    <th className={s.th}>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {REST_ROWS.map((r) => (
                    <tr key={r.method + r.path} className={s.tr}>
                      <td className={s.td}>
                        <MethodBadge m={r.method} />
                      </td>
                      <td className={`${s.td} ${s.monoCell}`}>
                        {r.path}
                        {r.llm ? <span className={s.llmChip}>LLM 约数秒</span> : null}
                      </td>
                      <td className={`${s.td} ${s.monoCell}`}>{r.body ?? "—"}</td>
                      <td className={`${s.td} ${s.monoCell}`}>{r.returns}</td>
                      <td className={s.td}>{r.notes ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.note}>
              客户端规则：不涉及 LLM 的接口 10 秒超时；/dialogues 与 /chat 不设客户端超时。查询参数用
              URLSearchParams 编码。DELETE 返回 204 且响应体为空 — 按成功处理，不要当解析错误。
            </p>
          </WanderMemorySection>

          <WanderMemorySection title="错误码">
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th className={s.th}>错误码</th>
                    <th className={s.th}>http</th>
                    <th className={s.th}>含义</th>
                  </tr>
                </thead>
                <tbody>
                  {ERROR_ROWS.map((e) => (
                    <tr key={e.code} className={s.tr}>
                      <td className={`${s.td} ${s.errorCell}`}>{e.code}</td>
                      <td className={`${s.td} ${s.monoCell}`}>{e.http}</td>
                      <td className={s.td}>{e.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </WanderMemorySection>

          <WanderMemorySection title="示例">
            <CodeBlock code={CURL_SNIPPET} title="curl" />
          </WanderMemorySection>
        </div>
      ) : null}

      {tab === "ws" ? (
        <div className={s.sections}>
          <WanderMemorySection title="帧结构">
            <CodeBlock code={WS_SNIPPET} title="ws://127.0.0.1:18401/v1/ws (§4.2)" />
            <p className={s.note}>
              请求携带单调递增的 id，对应帧据此匹配返回。id: null 的帧属于服务端控制帧（pong）。空白字符需注意：服务端分块会丢
              失块边界的空白 — 增量按原样显示，但以 done 帧的 reply 为最终结果。
            </p>
          </WanderMemorySection>

          <WanderMemorySection title="操作">
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th className={s.th}>操作</th>
                    <th className={s.th}>载荷</th>
                    <th className={s.th}>结果</th>
                    <th className={s.th}>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {WS_OPS_ROWS.map((r) => (
                    <tr key={r.op} className={s.tr}>
                      <td className={`${s.td} ${s.opCell}`}>{r.op}</td>
                      <td className={`${s.td} ${s.monoCell}`}>{r.payload}</td>
                      <td className={`${s.td} ${s.monoCell}`}>{r.result}</td>
                      <td className={s.td}>{r.notes ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </WanderMemorySection>

          <WanderMemorySection title="连接生命周期">
            <ul className={s.list}>
              <li>
                保活：客户端每 25 秒发送 <code className={s.inlineCode}>{"{\"type\":\"ping\"}"}</code>；服务端回 pong。
              </li>
              <li>
                死连接检测：有请求挂起时 60 秒内没有任何帧 → 重连，并以 llm_unavailable 让挂起请求失败。
              </li>
              <li>重连：指数退避 250 毫秒 → 8 秒，带抖动，close/error 时自动触发。</li>
              <li>挂起请求只会失败，绝不重放 — 写入不幂等，且冲突判定流程是有状态的。</li>
              <li>每个页面共用一个 socket；服务端把阻塞的记忆调用放在工作线程里跑，所以各操作会交错。</li>
            </ul>
          </WanderMemorySection>
        </div>
      ) : null}

      {tab === "connect" ? (
        <div className={s.sections}>
          <WanderMemorySection title="拓扑">
            <p className={s.note}>
              生产环境下由记忆 API 服务自身托管这个单页应用，因此 REST 调用同源，不需要任何 CORS 机制。WebSocket 在另一个端口
              （18401），属于不同源 — 但 WS 握手不受同源策略约束，服务端也未做 Origin 白名单，所以单页应用可以跨端口连接，
              无需改动服务端。
            </p>
            <CodeBlock code={BACKEND_SNIPPET} title="run" />
          </WanderMemorySection>

          <WanderMemorySection title="服务端静态托管（小幅增量）">
            <CodeBlock code={PYTHON_SNIPPET} title="src/memory/api.py" />
          </WanderMemorySection>

          <WanderMemorySection title="把界面指向你的后端">
            <ul className={s.list}>
              <li>
                默认端点：REST <code className={s.inlineCode}>http://127.0.0.1:18400/v1</code>，WS{" "}
                <code className={s.inlineCode}>ws://127.0.0.1:18401/v1/ws</code>。
              </li>
              <li>
                当页面由 18400 端口提供时，界面会自动从 location.host 推导两者（端口替换 18400 → 18401）。
              </li>
              <li>
                覆盖方式：<code className={s.inlineCode}>?api=</code> 查询参数，或「状态 → 端点设置」那一行（ui-store 键{" "}
                <code className={s.inlineCode}>wander-memory.apiOrigin</code> /{" "}
                <code className={s.inlineCode}>wander-memory.wsUrl</code>）。
              </li>
              <li>任何地方都不带鉴权头。绑定固定在 127.0.0.1 — 若把 API 重新绑定到局域网，单页应用会继承同样的暴露面。</li>
              <li>远程后端的 api_key 永远不离开服务端；前端看不到它。</li>
            </ul>
          </WanderMemorySection>
        </div>
      ) : null}
      </div>
    </div>
  );
}

export function WanderMemoryApiDocsRoute() {
  return (
    <WanderMemoryLayout title="API 参考" sub="MemOS · API">
      <ApiDocsPage />
    </WanderMemoryLayout>
  );
}
