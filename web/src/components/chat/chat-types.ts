import type { MediaItem } from "@/lib/media-tags";
import type { AssistantTurnBlock, ImageEntry, ToolEntry } from "@/stores/chat";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatToolItem extends ToolEntry {
  arguments?: Record<string, unknown>;
  images?: ChatImageItem[];
}

export type ChatImageItem = ImageEntry;

export type ChatMediaItem = MediaItem;

export interface ChatMediaBlock {
  type: "media";
  items: ChatMediaItem[];
}

export type ChatTurnBlock = AssistantTurnBlock | ChatMediaBlock;

export interface AssistantMessageStats {
  ttftMs?: number;
  durationMs?: number;
  tokensTotal?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensCompletion?: number;
  tokPerSec?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  model?: string;
  apiCalls?: number;
  finishReason?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  createdAt: number;
  text?: string;
  reasoning?: string;
  images?: ChatImageItem[];
  media?: ChatMediaItem[];
  tools?: ChatToolItem[];
  blocks?: ChatTurnBlock[];
  status?: "streaming" | "complete" | "error";
  title?: string;
  error?: boolean;
  stats?: AssistantMessageStats;
}
