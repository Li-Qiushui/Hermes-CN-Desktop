// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/chat.tsx — #/wander-memory/chat: streaming chat over
// /v1/ws with REST fallback (§6.4). Ported from WanderMemory
// `web/app/src/views/ChatView.tsx` onto the Jotai transcript atoms + the
// streaming chat controller (useWanderMemoryChatStream):
//   • deltas append live into the streaming assistant bubble
//   • the done frame's reply REPLACES the bubble (authoritative)
//   • WS down → the controller falls back to REST POST /v1/chat (the badge
//     reflects the current socket state)
//   • composer disabled mid-turn; Esc cancels client-side (documented
//     limitation: server-side generation is not cancellable — the late frame
//     is discarded by the controller's per-send epoch)
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Alert, Badge, Button, Input } from "@hermes/shared-ui";
import { WanderMemoryLayout } from "@/components/wander-memory/layout";
import { useWanderMemoryChatStream } from "@/hooks/use-wander-memory";
import { getWanderMemoryClient, wanderErrorLine } from "@/lib/wander-memory";
import type { ConnectionState } from "@/lib/wander-memory";
import {
  clearWanderMemoryChatAtom,
  wanderMemoryChatMessagesAtom,
} from "@/stores/wander-memory-chat";
import s from "./chat.module.css";

/** Live WS connection state from the singleton client (no-op in demo mode). */
function useWanderMemoryWsState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(() =>
    getWanderMemoryClient().streamingAvailable() ? "open" : "closed",
  );
  useEffect(() => {
    const client = getWanderMemoryClient();
    const unsub = client.onWsStateChange?.(setState);
    return () => {
      unsub?.();
    };
  }, []);
  return state;
}

function ChatPage() {
  const messages = useAtomValue(wanderMemoryChatMessagesAtom);
  const clearChat = useSetAtom(clearWanderMemoryChatAtom);
  const { send, cancel, isStreaming } = useWanderMemoryChatStream();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsState = useWanderMemoryWsState();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const submit = () => {
    const q = input.trim();
    if (!q || isStreaming) return;
    setInput("");
    send(q);
  };

  const mode = getWanderMemoryClient().mode;
  const streamBadge =
    mode === "demo" ? (
      <Badge tone="warning" variant="outline" size="sm">
        模拟流式
      </Badge>
    ) : wsState === "open" ? (
      <Badge tone="success" variant="outline" size="sm">
        WS 流式
      </Badge>
    ) : (
      <Badge tone="warning" variant="outline" size="sm">
        流式不可用 — 改用 REST
      </Badge>
    );

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.header}>
        <span className={s.title}>聊天</span>
        {streamBadge}
        <span className={s.hint}>Esc 只中断前端显示，服务端还会继续生成（一般几秒）</span>
        <span className={s.spacer} />
        <Button
          type="button"
          variant="plain"
          size="xs"
          disabled={messages.length === 0}
          onClick={() => clearChat()}
        >
          清空对话
        </Button>
      </div>

      <div ref={scrollRef} className={s.feed}>
        {messages.length === 0 ? (
          <p className={s.empty}>
            问点什么 — 回答基于 LLM 生成的关键词 + 词法召回
          </p>
        ) : (
          messages.map((msg, i) => (
            <div
              key={i}
              className={msg.role === "user" ? `${s.row} ${s.userRow}` : `${s.row} ${s.assistantRow}`}
            >
              <div className={msg.role === "user" ? s.userBubble : s.assistantBubble}>
                <p className={s.bubbleText}>
                  {msg.text}
                  {msg.streaming ? <span className={s.cursor} aria-hidden="true" /> : null}
                </p>

                {msg.error ? (
                  <Alert tone="danger" size="sm" className={s.msgError}>
                    {wanderErrorLine(msg.error)}
                  </Alert>
                ) : null}

                {msg.role === "assistant" && !msg.streaming && !msg.error ? (
                  msg.dreamed && msg.dreamed.length > 0 ? (
                    <div className={s.grounding}>
                      <div className={s.keywords}>
                        关键词：{msg.dreamed.join(" · ")}
                        {msg.groundedCount !== undefined
                          ? ` → 命中 ${msg.groundedCount} 条记忆`
                          : ""}
                      </div>
                      {msg.groundedSnippets && msg.groundedSnippets.length > 0 ? (
                        <ul className={s.snippets}>
                          {msg.groundedSnippets.map((snippet, j) => (
                            <li key={j}>· {snippet}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : (
                    <div className={s.groundingPlain}>
                      仅基于词法召回（关键词解析失败）
                    </div>
                  )
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      <div className={s.composer}>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape" && isStreaming) cancel();
          }}
          disabled={isStreaming}
          placeholder={
            isStreaming ? "等待回复…（Esc 仅取消前端）" : "输入消息…"
          }
          mono
        />
        <Button
          type="button"
          variant="solid"
          tone="accent"
          onClick={submit}
          loading={isStreaming}
          disabled={isStreaming || !input.trim()}
        >
          发送
        </Button>
      </div>
      </div>
    </div>
  );
}

export function WanderMemoryChatRoute() {
  return (
    <WanderMemoryLayout title="对话" sub="MemOS · 聊天">
      <ChatPage />
    </WanderMemoryLayout>
  );
}
