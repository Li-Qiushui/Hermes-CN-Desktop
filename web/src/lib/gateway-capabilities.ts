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

/** 记下某个 method 不被当前内核支持；没有 method 名时无法作为缓存键，直接丢弃。 */
export function rememberUnsupportedMethod(info: GatewayErrorInfo): void {
  if (info.kind !== "unsupported-method") return;
  if (!info.method) return;
  unsupportedMethods.set(info.method, info);
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
  unsupportedMethods.clear();
}
