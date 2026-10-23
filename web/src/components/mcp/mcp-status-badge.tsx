import { Badge } from "@hermes/shared-ui";
import { MCP_STATUS_META, type McpServerStatus } from "@/lib/mcp-status";

export function McpStatusBadge({ status }: { status: McpServerStatus }) {
  const meta = MCP_STATUS_META[status];
  return (
    <Badge tone={meta.tone} variant="outline" size="sm" data-status={status}>
      {meta.label}
    </Badge>
  );
}
