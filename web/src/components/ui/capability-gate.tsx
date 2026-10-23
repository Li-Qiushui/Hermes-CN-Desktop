import type { ReactNode } from "react";
import { useFeatureStatus, type GatewayFeatureId } from "@/lib/gateway-capabilities";

interface CapabilityGateProps {
  feature: GatewayFeatureId;
  children: ReactNode;
  fallback?: ReactNode;
}

export function CapabilityGate({ feature, children, fallback = null }: CapabilityGateProps) {
  const status = useFeatureStatus(feature);
  if (status === "unavailable") return <>{fallback}</>;
  return <>{children}</>;
}
