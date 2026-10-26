import { FileText, FolderTree, History, Paperclip, Sparkles, Wand2 } from "lucide-react";
import { NewChatEntries } from "./new-chat-entries";
import s from "./empty-chat-guide.module.css";

export { RECENT_SESSION_LIMIT, pickRecentSessions, recentSessionTime } from "./new-chat-entries";

export interface EmptyChatGuideProps {
  onPick: (text: string) => void;
}

const GUIDE_ITEMS = [
  { text: "帮我看看这个目录的代码结构", icon: FolderTree },
  { text: "解释这段报错", icon: FileText },
  { text: "把这批文件重命名", icon: Wand2 },
  { text: "继续上次那个任务", icon: History },
] as const;

export function EmptyChatGuide({ onPick }: EmptyChatGuideProps) {
  return (
    <div className={s.guide} data-empty-guide="true">
      <div className={s.head}>
        <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" className={s.headIcon} />
        <span className={s.title}>写下你的第一句话</span>
      </div>
      <div className={s.items}>
        {GUIDE_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.text}
              type="button"
              className={s.item}
              onClick={() => onPick(item.text)}
              title="填入输入框，可再修改后发送"
            >
              <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>{item.text}</span>
            </button>
          );
        })}
      </div>
      <NewChatEntries />
      <p className={s.hint}>
        <Paperclip size={12} strokeWidth={1.75} aria-hidden="true" />
        可以把文件拖进来，也可以粘贴长文本（会自动转成附件）。
      </p>
    </div>
  );
}
