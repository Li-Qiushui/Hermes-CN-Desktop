import { useSyncExternalStore } from "react";
import type { GatewayErrorInfo } from "./gateway-result";

/**
 * 会话级能力缓存：某个 RPC 一旦被内核判为「方法不存在 / 未实现 / 版本错配」，
 * 本次连接内就不再拿它去打网关。
 *
 * 和 `classifyGatewayError` 的分工：那边是纯分类，这里只存状态。缓存里放的是
 * 统一分类后的结构化错误（`kind: "unsupported-method"`），命中时直接把它当
 * 失败结果返回，调用方拿到的错误文本和首次失败完全一致。
 *
 * 调用方用法：缓存是 `GatewayClient.request()` 内部自动读写的能力，业务侧不用
 * 手动维护；重连 / 换内核之后由 `GatewayClient` 调用 `forgetGatewayCapabilities()`
 * 重置，需要手动重置（例如切换后端配置）时也直接调它。
 */

const unsupportedMethods = new Map<string, GatewayErrorInfo>();

const capabilityListeners = new Set<() => void>();
let capabilityVersion = 0;

function notifyCapabilityChange(): void {
  capabilityVersion += 1;
  for (const listener of [...capabilityListeners]) listener();
}

/** 订阅能力变化：缓存里新增一条「不支持」或整体清空时触发，供 React 侧重渲染。 */
export function subscribeGatewayCapabilities(listener: () => void): () => void {
  capabilityListeners.add(listener);
  return () => {
    capabilityListeners.delete(listener);
  };
}

export function gatewayCapabilityVersion(): number {
  return capabilityVersion;
}

/** 记下某个 method 不被当前内核支持；没有 method 名时无法作为缓存键，直接丢弃。 */
export function rememberUnsupportedMethod(info: GatewayErrorInfo): void {
  if (info.kind !== "unsupported-method") return;
  if (!info.method) return;
  const known = unsupportedMethods.has(info.method);
  unsupportedMethods.set(info.method, info);
  if (!known) notifyCapabilityChange();
}

/** 命中缓存的失败；未命中返回 null（代表「还没结论」，正常去打网关）。 */
export function cachedUnsupportedMethod(method: string | undefined): GatewayErrorInfo | null {
  if (!method) return null;
  return unsupportedMethods.get(method) ?? null;
}

export function isMethodKnownUnsupported(method: string): boolean {
  return unsupportedMethods.has(method);
}

export function listUnsupportedMethods(): string[] {
  return Array.from(unsupportedMethods.keys()).sort();
}

/** 清空能力缓存：重连、换内核、切后端之后必须调一次，否则会一直快失败。 */
export function forgetGatewayCapabilities(): void {
  if (unsupportedMethods.size === 0) return;
  unsupportedMethods.clear();
  notifyCapabilityChange();
}

/** 功能对外的三态：未知（还没探测过）按可用处理，避免内核慢启动时入口先闪没。 */
export type CapabilityStatus = "available" | "degraded" | "unavailable";

export interface GatewayFeatureSpec {
  /** 只在兜底页 / 诊断里显示的短名。 */
  label: string;
  /** 该功能离不开的内核方法；任一被判「不支持」即视为整块不可用。 */
  methods: readonly string[];
  /** true = 方法缺失时还有替代路径，降级保留入口，不隐藏。 */
  degradable?: boolean;
}

/**
 * 功能 → 依赖方法的唯一一张表。页面入口、按钮、路由兜底都只认这里，
 * 别在组件里散写方法名判断。
 */
export const GATEWAY_FEATURES = {
  "session.detail": { label: "会话详情", methods: ["session.resume"] },
  "composer.steer": { label: "运行中引导", methods: ["session.steer"], degradable: true },
  "mcp.reload": { label: "MCP 即时重载", methods: ["reload.mcp"] },
  "prompt.clarify": { label: "澄清提问作答", methods: ["clarify.respond"] },
  "models.catalog": {
    label: "供应商模型目录",
    methods: ["provider.models"],
    degradable: true,
  },
} as const satisfies Record<string, GatewayFeatureSpec>;

export type GatewayFeatureId = keyof typeof GATEWAY_FEATURES;

/** 该功能当前缺哪个方法；没缺返回 undefined。 */
export function unavailableFeatureMethod(feature: GatewayFeatureId): string | undefined {
  return GATEWAY_FEATURES[feature].methods.find((method) => isMethodKnownUnsupported(method));
}

export function featureStatus(feature: GatewayFeatureId): CapabilityStatus {
  if (!unavailableFeatureMethod(feature)) return "available";
  const spec: GatewayFeatureSpec = GATEWAY_FEATURES[feature];
  return spec.degradable ? "degraded" : "unavailable";
}

/** 入口（导航项 / 侧栏项 / 按钮）是否该渲染。未知与降级都算可见。 */
export function isFeatureEntryVisible(feature: GatewayFeatureId): boolean {
  return featureStatus(feature) !== "unavailable";
}

export function useFeatureStatus(feature: GatewayFeatureId): CapabilityStatus {
  return useSyncExternalStore(
    subscribeGatewayCapabilities,
    () => featureStatus(feature),
    () => "available" as CapabilityStatus,
  );
}
