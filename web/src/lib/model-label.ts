/** Short model / context labels shared by the topbar model chip and the status bar. */

export function formatModelShort(model: string | null | undefined): string {
  if (!model) return "—";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function formatContext(ctx: number | null | undefined): string {
  if (!ctx || ctx <= 0) return "—";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M`;
  if (ctx >= 1_000) return `${(ctx / 1_000).toFixed(0)}k`;
  return `${ctx}`;
}
