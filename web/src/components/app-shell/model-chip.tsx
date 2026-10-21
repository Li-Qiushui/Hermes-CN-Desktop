import { useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { useModelInfo } from "@/hooks/use-config";
import { formatContext, formatModelShort } from "@/lib/model-label";
import s from "./app-top-bar.module.css";

/** 顶栏模型卡：当前模型 + 上下文长度，点击进入「配置 · 模型」。 */
export function ModelChip() {
  const navigate = useNavigate();
  const { data: modelInfo } = useModelInfo();

  const modelLabel = formatModelShort(modelInfo?.model);
  const contextLabel = formatContext(
    modelInfo?.effective_context_length ?? modelInfo?.auto_context_length,
  );

  return (
    <button
      type="button"
      className={s.chip}
      onClick={() => navigate("/models")}
      title={`模型 ${modelLabel} · 上下文 ${contextLabel}（点击打开 配置 · 模型）`}
      aria-label={`模型 ${modelLabel}，上下文 ${contextLabel}`}
      data-no-drag
    >
      <span className={s.chipValue}>{modelLabel}</span>
      <span className={s.chipMeta}>{contextLabel}</span>
      <ChevronDown size={12} className={s.chipChevron} aria-hidden="true" />
    </button>
  );
}
