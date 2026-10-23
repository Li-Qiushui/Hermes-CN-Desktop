import { useNavigate } from "react-router-dom";
import { ArrowLeft, PlugZap } from "lucide-react";
import {
  GATEWAY_FEATURES,
  unavailableFeatureMethod,
  type GatewayFeatureId,
} from "@/lib/gateway-capabilities";
import s from "./feature-unsupported.module.css";

interface FeatureUnsupportedPageProps {
  feature: GatewayFeatureId;
}

export function FeatureUnsupportedPage({ feature }: FeatureUnsupportedPageProps) {
  const navigate = useNavigate();
  const spec = GATEWAY_FEATURES[feature];
  const method = unavailableFeatureMethod(feature);
  return (
    <div className={s.page} data-testid="feature-unsupported">
      <PlugZap size={28} className={s.icon} aria-hidden="true" />
      <p className={s.title}>当前内核不支持该功能</p>
      <p className={s.detail} data-testid="feature-unsupported-detail">
        {spec.label}
        {method ? `（${method}）` : ""}需要的内核方法在这台内核上不存在，入口已自动隐藏。
      </p>
      <button type="button" className={s.back} data-testid="feature-unsupported-back" onClick={() => navigate("/")}>
        <ArrowLeft size={14} aria-hidden="true" />
        返回工作台
      </button>
    </div>
  );
}
