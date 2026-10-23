import type { ReactNode } from "react";
import { useFeatureStatus, type GatewayFeatureId } from "@/lib/gateway-capabilities";
import { FeatureUnsupportedPage } from "./feature-unsupported";

interface CapabilityRouteGuardProps {
  feature: GatewayFeatureId;
  children: ReactNode;
}

export function CapabilityRouteGuard({ feature, children }: CapabilityRouteGuardProps) {
  const status = useFeatureStatus(feature);
  if (status === "unavailable") return <FeatureUnsupportedPage feature={feature} />;
  return <>{children}</>;
}
