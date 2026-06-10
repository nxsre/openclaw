// 调用方(客户端 WS)断开后,宽限 graceMs 再 abort 该连接持有的 in-flight run;宽限期内同 device
// 重连则取消(接管那些 run,不中止)。这把"连接断开"从默认的 fire-and-forget(run 继续在后台跑完
// 落库)改成"宽限后主动结束未完成动作",避免断开的客户端留下无人接收、却仍占 session / 烧 LLM 的
// 孤儿 run。宽限是为容忍网络抖动 / 切后台的瞬断:短时间内同 device 重连就不取消。
//
// 开关:OPENCLAW_ABORT_RUN_ON_DISCONNECT  默认开;设 "0" 关闭(回到 fire-and-forget)。
// 宽限:OPENCLAW_ABORT_RUN_ON_DISCONNECT_GRACE_MS  默认 8000ms;<=0 表示断开即取消、不等。
//
// 纯状态机:不依赖任何 openclaw 内部模块,真正的 abort 由调用方注入的回调执行(避免与 gateway
// 连接处理产生 import 环)。

const ENABLED = process.env.OPENCLAW_ABORT_RUN_ON_DISCONNECT !== "0";

const GRACE_MS = (() => {
  const raw = Number(process.env.OPENCLAW_ABORT_RUN_ON_DISCONNECT_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 8_000;
})();

type PendingAbort = { timer: ReturnType<typeof setTimeout>; deviceId?: string };

// key: connId(每条连接唯一)。重连是新 connId,所以"接管"按 deviceId 匹配,见下。
const pendingByConn = new Map<string, PendingAbort>();

export function isDisconnectRunAbortEnabled(): boolean {
  return ENABLED;
}

// 断开时调度。graceMs<=0 立即执行 abort;否则起一个可被重连取消的定时器。
export function scheduleDisconnectRunAbort(opts: {
  connId: string;
  deviceId?: string;
  abort: () => void;
}): void {
  cancelDisconnectRunAbort(opts.connId); // 同一连接重复 close 去重
  if (GRACE_MS <= 0) {
    opts.abort();
    return;
  }
  const timer = setTimeout(() => {
    pendingByConn.delete(opts.connId);
    try {
      opts.abort();
    } catch {
      /* abort 回调内部自行容错;调度器不抛 */
    }
  }, GRACE_MS);
  // 不让这个定时器拖住进程退出(它只是机会性清理)。
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  pendingByConn.set(opts.connId, { timer, deviceId: opts.deviceId });
}

// 取消某条连接的 pending(重复 close / 连接对象清理时调用)。
export function cancelDisconnectRunAbort(connId: string): void {
  const pending = pendingByConn.get(connId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingByConn.delete(connId);
}

// 同 device 重连 → 取消该 device 此前断开时调度的所有 abort,让仍在跑的 run 继续(接管)。
export function cancelDisconnectRunAbortForDevice(deviceId: string | undefined): void {
  if (!deviceId) return;
  for (const [connId, pending] of pendingByConn) {
    if (pending.deviceId === deviceId) {
      clearTimeout(pending.timer);
      pendingByConn.delete(connId);
    }
  }
}
