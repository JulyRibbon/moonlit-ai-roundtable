import {
  BridgeError,
  VOICE_MODES,
  assertContextPacket,
  normalizeCapabilities,
  unsupportedCapability,
} from '../contract.mjs';
import { BRIDGE_EVENT_TYPES, createBridgeEvent } from '../../core/events.mjs';

const DEFAULT_CLIENT_VERSION = 'fake-bridge/1.0.0';

const speechPhaseTypes = Object.freeze({
  started: BRIDGE_EVENT_TYPES.SPEECH_STARTED,
  finished: BRIDGE_EVENT_TYPES.SPEECH_FINISHED,
  failed: BRIDGE_EVENT_TYPES.SPEECH_FAILED,
});

/** 可序列化的浅拷贝，避免把内部状态暴露给调用方。 */
function cloneMetadata(metadata) {
  return metadata === undefined ? undefined : structuredClone(metadata);
}

/**
 * 契约测试专用的确定性 Bridge 实现。
 *
 * 它不访问网络、不启动定时器，只把「原生会话里发生的事」变成 Bridge v1 事件：
 * 测试通过 completeAttempt / failAttempt / injectNativeFinalMessage / injectForeignTurn /
 * injectSpeech* 显式驱动事件，因此每个测试都能拿到固定的顺序与次数。
 */
export class FakeBridge {
  constructor(config = {}) {
    this._config = {
      allowCreateSession: false,
      supportsMute: false,
      voiceMode: VOICE_MODES.NONE,
      ...config,
    };
    this._connected = false;
    this._closed = false;
    this._sessionRef = config.nativeSessionRef ?? null;
    this._sessionCreated = false;
    this._createSequence = 0;
    this._attempts = new Map();
    this._activeAttempt = null;
    this._cancelReceipts = new Map();
    this._seenFinalRefs = new Set();
    this._pending = [];
    this._subscribers = new Set();
    this._eventCount = 0;
    this._muted = false;
  }

  // ── Bridge v1 接口 ──────────────────────────────────────────────────────────

  async probe(config = {}) {
    const cfg = this._mergedConfig(config);
    this._requireSeat(cfg);
    const voiceMode = cfg.voiceMode ?? VOICE_MODES.NONE;
    const supportsVoiceEvents = voiceMode !== VOICE_MODES.NONE && cfg.supportsVoiceEvents !== false;
    const sessionRef = cfg.nativeSessionRef ?? this._sessionRef ?? null;
    const identity = sessionRef === null ? undefined : this._identityFor(cfg, sessionRef);
    return {
      capabilities: normalizeCapabilities({
        nativeSession: true,
        nativeIdentity: true,
        sendToExistingSession: true,
        finalMessageEvent: true,
        messageDeduplication: true,
        snapshotRecovery: null,
        foreignTurnDetection: true,
        queueClear: null,
        requestAbort: true,
        providerUsage: null,
        voiceTrigger: supportsVoiceEvents,
        voiceStartedFinishedEvents: supportsVoiceEvents,
        voiceStop: false,
        voiceMute: Boolean(cfg.supportsMute),
        ...(cfg.capabilities ?? {}),
      }),
      identity,
      clientVersion: cfg.clientVersion ?? DEFAULT_CLIENT_VERSION,
      voiceMode,
      warnings: [...(cfg.warnings ?? [])],
    };
  }

  async connect(config = {}) {
    if (this._closed) {
      throw new BridgeError('BRIDGE_CLOSED', 'Bridge is closed.');
    }
    if (this._connected) return;
    this._config = this._mergedConfig(config);
    this._requireSeat(this._config);
    let sessionRef = this._config.nativeSessionRef ?? this._sessionRef;
    if (sessionRef === null || sessionRef === undefined) {
      if (!this._config.allowCreateSession) {
        throw new BridgeError(
          'SESSION_REQUIRED',
          'connect() requires nativeSessionRef unless allowCreateSession is true.',
        );
      }
      sessionRef = `fake_session_${this._config.seatId}`;
      this._sessionCreated = true;
    }
    this._sessionRef = sessionRef;
    this._connected = true;
  }

  async getIdentity() {
    const sessionRef = this._sessionRef ?? this._config.nativeSessionRef ?? null;
    if (sessionRef === null) {
      throw new BridgeError('IDENTITY_UNAVAILABLE', 'No native session reference is available.');
    }
    return this._identityFor(this._config, sessionRef);
  }

  async createNativeSession() {
    this._createSequence += 1;
    return { nativeSessionRef: `fake_session_${this._config.seatId}_${this._createSequence}` };
  }

  async send(packet) {
    if (this._closed) {
      throw new BridgeError('BRIDGE_CLOSED', 'Bridge is closed.');
    }
    if (!this._connected) {
      throw new BridgeError('BRIDGE_NOT_CONNECTED', 'connect() must be called before send().');
    }
    assertContextPacket(packet);
    if (packet.seatId !== this._config.seatId) {
      throw new BridgeError('CONTEXT_SEAT_MISMATCH', 'Context packet seatId does not match this bridge.', {
        details: { expected: this._config.seatId, actual: packet.seatId },
      });
    }
    if (this._attempts.has(packet.attemptId)) {
      throw new BridgeError('ATTEMPT_ID_REUSED', `Attempt already exists: ${packet.attemptId}`, {
        details: { attemptId: packet.attemptId },
      });
    }
    if (this._activeAttempt !== null) {
      throw new BridgeError('BRIDGE_BUSY', 'Seat already has an active attempt.', {
        retryable: true,
        details: { attemptId: this._activeAttempt.attemptId },
      });
    }

    const attempt = {
      attemptId: packet.attemptId,
      nativeTurnRef: `${packet.attemptId}:turn`,
      nativeRequestRef: `${packet.attemptId}:request`,
      status: 'running',
      partialText: '',
      text: null,
      usage: null,
      packet: { ...packet },
    };
    this._attempts.set(attempt.attemptId, attempt);
    this._activeAttempt = attempt;
    this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_STARTED, attempt.attemptId, {
      nativeTurnRef: attempt.nativeTurnRef,
    });
    return {
      attemptId: attempt.attemptId,
      accepted: true,
      nativeRequestRef: attempt.nativeRequestRef,
    };
  }

  subscribe() {
    const initial = this._pending;
    this._pending = [];
    const subscriber = { queue: initial, wake: null, closed: this._closed };
    if (!this._closed) this._subscribers.add(subscriber);
    const generator = this._iterate(subscriber);
    // 包装 return()：即使生成器正卡在等待事件上，也先主动唤醒并注销，
    // 避免调用方拿到的 return() 一直悬挂。
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => generator.next(),
      return: (value) => {
        subscriber.closed = true;
        this._subscribers.delete(subscriber);
        const wake = subscriber.wake;
        subscriber.wake = null;
        wake?.();
        return generator.return(value);
      },
      throw: (error) => generator.throw(error),
    };
  }

  async cancel(attemptId) {
    const cached = this._cancelReceipts.get(attemptId);
    if (cached) return { ...cached };

    const attempt = this._attempts.get(attemptId);
    if (!attempt) {
      return {
        attemptId,
        accepted: false,
        settlement: 'failed',
        error: { code: 'ATTEMPT_NOT_FOUND', message: `Unknown attempt: ${attemptId}`, retryable: false },
      };
    }
    if (this._closed) {
      const receipt = {
        attemptId,
        accepted: false,
        settlement: 'failed',
        nativeTurnRef: attempt.nativeTurnRef,
        error: { code: 'BRIDGE_CLOSED', message: 'Bridge is closed.', retryable: false },
      };
      this._cancelReceipts.set(attemptId, receipt);
      return { ...receipt };
    }
    if (attempt.status !== 'running') {
      const receipt = {
        attemptId,
        accepted: false,
        settlement: 'failed',
        nativeTurnRef: attempt.nativeTurnRef,
        error: {
          code: 'ATTEMPT_ALREADY_FINISHED',
          message: `Attempt is already ${attempt.status}.`,
          retryable: false,
        },
      };
      this._cancelReceipts.set(attemptId, receipt);
      return { ...receipt };
    }

    attempt.status = 'aborted';
    this._clearActive(attempt);
    const payload = {
      nativeTurnRef: attempt.nativeTurnRef,
      partialText: attempt.partialText,
    };
    if (attempt.usage !== null) payload.usage = attempt.usage;
    this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_ABORTED, attemptId, payload);
    const receipt = {
      attemptId,
      accepted: true,
      settlement: 'confirmed',
      nativeTurnRef: attempt.nativeTurnRef,
    };
    this._cancelReceipts.set(attemptId, receipt);
    return { ...receipt };
  }

  async setMuted(muted) {
    if (!this._config.supportsMute) return unsupportedCapability('voiceMute');
    this._muted = Boolean(muted);
    return { supported: true, muted: this._muted, capability: 'voiceMute' };
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this._connected = false;
    this._emit(BRIDGE_EVENT_TYPES.BRIDGE_CLOSED, null, { reason: 'closed' });
    for (const subscriber of this._subscribers) {
      subscriber.closed = true;
      const wake = subscriber.wake;
      subscriber.wake = null;
      wake?.();
    }
    this._subscribers.clear();
  }

  // ── 确定性测试控制 ──────────────────────────────────────────────────────────

  /**
   * 模拟一次原生 turn 完成。按 nativeTurnRef / nativeMessageRef 去重（不按正文），
   * 同一 attempt 只会产生一个终结事件。
   */
  completeAttempt(attemptId, options = {}) {
    const attempt = this._attempts.get(attemptId);
    if (!attempt) return { delivered: false, reason: 'attempt-not-found' };
    if (this._closed) return { delivered: false, reason: 'bridge-closed' };
    if (attempt.status !== 'running') return { delivered: false, reason: 'attempt-not-running' };

    const nativeTurnRef = options.nativeTurnRef ?? attempt.nativeTurnRef;
    const nativeMessageRef = options.nativeMessageRef ?? `${nativeTurnRef}:message`;
    if (this._seenFinalRefs.has(nativeTurnRef) || this._seenFinalRefs.has(nativeMessageRef)) {
      return { delivered: false, reason: 'duplicate' };
    }
    this._seenFinalRefs.add(nativeTurnRef);
    this._seenFinalRefs.add(nativeMessageRef);

    const text = options.text ?? '';
    attempt.status = 'completed';
    attempt.text = text;
    attempt.usage = options.usage ?? null;
    this._clearActive(attempt);
    const payload = { nativeTurnRef, nativeMessageRef, text };
    if (options.usage !== undefined) payload.usage = options.usage;
    const event = this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_COMPLETED, attemptId, payload);
    return { delivered: true, event };
  }

  /** 模拟原生终态消息重复到达；与 completeAttempt 共用同一套引用去重。 */
  injectNativeFinalMessage(attemptId, options = {}) {
    return this.completeAttempt(attemptId, options);
  }

  failAttempt(attemptId, options = {}) {
    const attempt = this._attempts.get(attemptId);
    if (!attempt) return { delivered: false, reason: 'attempt-not-found' };
    if (this._closed) return { delivered: false, reason: 'bridge-closed' };
    if (attempt.status !== 'running') return { delivered: false, reason: 'attempt-not-running' };

    const error = options.error ?? {
      code: 'FAKE_FAILURE',
      message: 'Injected failure.',
      retryable: false,
    };
    attempt.status = 'failed';
    this._clearActive(attempt);
    const payload = { error, nativeTurnRef: options.nativeTurnRef ?? attempt.nativeTurnRef };
    if (options.usage !== undefined) payload.usage = options.usage;
    const event = this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_FAILED, attemptId, payload);
    return { delivered: true, event };
  }

  /** 取消时保留已经生成的部分正文；正文只进 AttemptAborted，不进 Completed。 */
  appendPartialText(attemptId, text) {
    const attempt = this._attempts.get(attemptId);
    if (!attempt || attempt.status !== 'running') return { appended: false };
    attempt.partialText += String(text ?? '');
    return { appended: true, partialText: attempt.partialText };
  }

  injectForeignTurn({ nativeTurnRef, reason = 'foreign-turn' } = {}) {
    if (this._closed) return { emitted: false, reason: 'bridge-closed' };
    if (typeof nativeTurnRef !== 'string' || nativeTurnRef.length === 0) {
      throw new BridgeError('NATIVE_TURN_REF_INVALID', 'ForeignTurn requires a non-empty nativeTurnRef.');
    }
    const event = this._emit(BRIDGE_EVENT_TYPES.FOREIGN_TURN, null, { nativeTurnRef, reason });
    return { emitted: true, event };
  }

  injectSpeech(phase, options = {}) {
    const type = speechPhaseTypes[phase];
    if (!type) {
      throw new BridgeError('SPEECH_PHASE_INVALID', `Unknown speech phase: ${phase}`, {
        details: { phase },
      });
    }
    if (this._config.voiceMode === VOICE_MODES.NONE || this._config.supportsVoiceEvents === false) {
      return { supported: false, emitted: false, capability: 'voiceStartedFinishedEvents' };
    }
    if (this._closed) return { supported: true, emitted: false, reason: 'bridge-closed' };

    const attemptId = options.attemptId ?? this._activeAttempt?.attemptId ?? null;
    let payload = {};
    if (options.nativeMessageRef) payload.nativeMessageRef = options.nativeMessageRef;
    if (phase === 'failed') {
      payload = {
        ...payload,
        error: options.error ?? {
          code: 'FAKE_SPEECH_FAILURE',
          message: 'Injected speech failure.',
          retryable: false,
        },
      };
    }
    const event = this._emit(type, attemptId, payload);
    return { supported: true, emitted: true, event };
  }

  injectSpeechStarted(options = {}) {
    return this.injectSpeech('started', options);
  }

  injectSpeechFinished(options = {}) {
    return this.injectSpeech('finished', options);
  }

  injectSpeechFailed(options = {}) {
    return this.injectSpeech('failed', options);
  }

  /** 只读快照，供测试断言内部状态；不产生事件、不改变任何状态。 */
  inspect() {
    return {
      seatId: this._config.seatId ?? null,
      connected: this._connected,
      closed: this._closed,
      sessionRef: this._sessionRef,
      sessionCreated: this._sessionCreated,
      activeAttemptId: this._activeAttempt?.attemptId ?? null,
      attemptCount: this._attempts.size,
      eventCount: this._eventCount,
      muted: this._muted,
      mutedSupported: Boolean(this._config.supportsMute),
      voiceMode: this._config.voiceMode ?? VOICE_MODES.NONE,
      subscriberCount: this._subscribers.size,
      pendingEventCount: this._pending.length,
    };
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────────

  _mergedConfig(config) {
    return { ...this._config, ...config };
  }

  _requireSeat(config) {
    if (typeof config.seatId !== 'string' || config.seatId.length === 0) {
      throw new BridgeError('CONFIG_INVALID', 'FakeBridge requires a non-empty seatId.');
    }
  }

  _identityFor(config, sessionRef) {
    return {
      sourceRef: config.identityRef ?? `${sessionRef}#identity`,
      revision: String(config.identityRevision ?? '1'),
      nativeSessionRef: sessionRef,
      metadata: cloneMetadata(config.identityMetadata) ?? {
        name: config.seatId,
        preset: 'fake',
      },
    };
  }

  _clearActive(attempt) {
    if (this._activeAttempt === attempt) this._activeAttempt = null;
  }

  _emit(type, attemptId, payload) {
    const event = createBridgeEvent({
      type,
      seatId: this._config.seatId,
      attemptId,
      payload,
    });
    this._eventCount += 1;
    if (this._subscribers.size === 0) {
      this._pending.push(event);
      return event;
    }
    for (const subscriber of this._subscribers) {
      subscriber.queue.push(event);
      const wake = subscriber.wake;
      subscriber.wake = null;
      wake?.();
    }
    return event;
  }

  async *_iterate(subscriber) {
    try {
      while (true) {
        while (subscriber.queue.length > 0) {
          yield subscriber.queue.shift();
        }
        if (subscriber.closed) return;
        await new Promise((resolve) => {
          subscriber.wake = resolve;
        });
      }
    } finally {
      this._subscribers.delete(subscriber);
      subscriber.closed = true;
      subscriber.wake = null;
    }
  }
}

export function createFakeBridge(config) {
  return new FakeBridge(config);
}
