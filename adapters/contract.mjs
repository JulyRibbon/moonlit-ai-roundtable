export const BRIDGE_CONTRACT_VERSION = 1;

export const BRIDGE_METHODS = Object.freeze([
  'probe',
  'connect',
  'getIdentity',
  'send',
  'subscribe',
  'cancel',
  'setMuted',
  'close',
]);

export const CAPABILITIES = Object.freeze([
  'nativeSession',
  'nativeIdentity',
  'sendToExistingSession',
  'finalMessageEvent',
  'messageDeduplication',
  'snapshotRecovery',
  'foreignTurnDetection',
  'queueClear',
  'requestAbort',
  'providerUsage',
  'voiceTrigger',
  'voiceStartedFinishedEvents',
  'voiceStop',
  'voiceMute',
]);

export const VOICE_MODES = Object.freeze({
  NATIVE: 'native',
  EXTERNAL: 'external',
  NONE: 'none',
});

export class BridgeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'BridgeError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function assertBridge(bridge) {
  if (!bridge || (typeof bridge !== 'object' && typeof bridge !== 'function')) {
    throw new BridgeError('BRIDGE_INVALID', 'Bridge must be an object.');
  }
  for (const method of BRIDGE_METHODS) {
    if (typeof bridge[method] !== 'function') {
      throw new BridgeError('BRIDGE_METHOD_MISSING', `Missing bridge method: ${method}()`, {
        details: { method },
      });
    }
  }
  return bridge;
}

export function normalizeCapabilities(capabilities = {}) {
  return Object.fromEntries(
    CAPABILITIES.map((name) => [name, capabilities[name] ?? null]),
  );
}

export function assertContextPacket(packet) {
  const requiredStrings = ['roomId', 'turnId', 'attemptId', 'seatId', 'text'];
  for (const field of requiredStrings) {
    if (typeof packet?.[field] !== 'string' || packet[field].length === 0) {
      throw new BridgeError('CONTEXT_PACKET_INVALID', `Context packet requires non-empty ${field}.`, {
        details: { field },
      });
    }
  }
  if (!Number.isSafeInteger(packet.roomSeq) || packet.roomSeq < 1) {
    throw new BridgeError('CONTEXT_PACKET_INVALID', 'Context packet requires roomSeq >= 1.', {
      details: { field: 'roomSeq' },
    });
  }
  if (typeof packet.contextEpoch !== 'string' || packet.contextEpoch.length === 0) {
    throw new BridgeError('CONTEXT_PACKET_INVALID', 'Context packet requires contextEpoch.', {
      details: { field: 'contextEpoch' },
    });
  }
  return packet;
}

export function unsupportedCapability(capability) {
  return Object.freeze({ supported: false, capability });
}

/**
 * @typedef {Object} BridgeConfig
 * @property {string} seatId
 * @property {string} nativeSessionRef
 * @property {boolean} [allowCreateSession=false]
 * @property {string} [baseUrl]
 * @property {string} [cwd]
 * @property {Object} [client]
 *
 * @typedef {Object} Identity
 * @property {string} sourceRef
 * @property {string} revision
 * @property {string} nativeSessionRef
 * @property {Object} [metadata] 仅名称、preset 等元数据，不包含人格正文副本。
 *
 * @typedef {Object} ContextPacket
 * @property {string} roomId
 * @property {number} roomSeq
 * @property {string} turnId
 * @property {string} attemptId
 * @property {string} seatId
 * @property {string} contextEpoch
 * @property {string} text 已渲染的房间增量，不包含房间重写的人格。
 * @property {string[]} [mentions]
 * @property {string} [replyTo]
 *
 * @typedef {Object} SendReceipt
 * @property {string} attemptId
 * @property {boolean} accepted 仅表示客户端接受投递，不表示已经生成最终回复。
 * @property {string} [nativeRequestRef]
 *
 * @typedef {Object} CancelReceipt
 * @property {string} attemptId
 * @property {boolean} accepted
 * @property {'confirmed'|'pending'|'failed'|'unsupported'} settlement
 * @property {string} [nativeTurnRef]
 * @property {Object} [error]
 *
 * Bridge 生命周期与行为约束：
 *
 * probe(config): Promise<{capabilities, identity?, clientVersion?, voiceMode, warnings?}>
 *   只读且不得产生模型调用；未知能力填 null，已确认不支持填 false。
 *
 * connect(config): Promise<void>
 *   连接 config.nativeSessionRef；未显式允许时不得创建、归档或替换原生会话。
 *   connect 后、subscribe 前发生的事件必须由 Bridge 缓冲。
 *
 * getIdentity(): Promise<Identity>
 *   返回原生身份引用和版本，不返回 AGENTS.md / SYSTEM.md / preset 正文副本。
 *
 * createNativeSession?(config): Promise<{nativeSessionRef:string}>
 *   可选能力：仅在机主明确点击“新会话”或开始含 AI 的棋局时调用；沿用原客户端 cwd / preset，
 *   不产生模型调用，不归档旧会话，不改变当前 Bridge；由调用方验证并接入。
 *
 * adoptNativeSession?(nativeSessionRef): Promise<Identity>
 *   可选的原地接管能力：同一客户端进程内 resume + subscribe 新 ID，清空旧尝试关联，
 *   不关闭客户端、不重放旧尝试；适合无法跨进程立即看到新会话的客户端。
 *
 * send(contextPacket): Promise<SendReceipt>
 *   调用前必须完成事件收集器与 pending attempt 登记。
 *   每席同时最多一个 active attempt；忙时抛 BRIDGE_BUSY。
 *   accepted=true 后仍须通过 subscribe() 等待 AttemptCompleted/Aborted/Failed。
 *
 * subscribe(): AsyncIterable<BridgeEvent>
 *   返回同一 Bridge 的持续事件流，不重放已经终结的历史 attempt。
 *   断线恢复只重建未结束 attempt，不得重复发布已完成消息。
 *
 * cancel(attemptId): Promise<CancelReceipt>
 *   幂等。RPC 被接受不等于 attempt 已终结；最终状态由事件流确认。
 *
 * setMuted(muted): Promise<{supported:boolean, muted?:boolean, capability?:string}>
 *   不支持时返回 unsupportedCapability('voiceMute')，不得抛未处理异常。
 *
 * close(): Promise<void>
 *   幂等；只释放 Bridge 资源，不归档或删除原生会话。
 */
