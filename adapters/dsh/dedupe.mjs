// DSH 原生回合去重账本。
//
// 去重键是 (sessionId, turn)：文字相同但 turn 不同的两轮必须都能交付；
// 同一 turn 的重复 turn/start、assistant/message、turn/end 只允许生效一次。
// 本模块不碰协议字段，只负责「见过没有」这三类事实。

/**
 * 组合 DSH 的原生去重键。
 * @param {string} sessionId
 * @param {string|number} turn
 * @returns {string}
 */
export function turnKey(sessionId, turn) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('turnKey requires a non-empty sessionId.');
  }
  if (turn === undefined || turn === null || turn === '') {
    throw new TypeError('turnKey requires a turn.');
  }
  return `${sessionId}\u0000${String(turn)}`;
}

/**
 * 一个会话（或一个 Bridge）内的回合账本。
 *
 * start / end / foreign 三个集合互不代偿：
 * - 先标 start，后标 end，才能从快照还原「有 start 无 end」的未结束回合；
 * - 终结过的回合再进快照时，`hasEnded` 为真，任何路径都不重放；
 * - `foreign` 只表示已经发过 ForeignTurn，不表示回合结束。
 */
export function createTurnLedger() {
  const started = new Set();
  const ended = new Set();
  const foreign = new Set();

  return {
    /** @returns {boolean} 第一次见到该 turn/start 时为 true。 */
    startTurn(sessionId, turn) {
      const key = turnKey(sessionId, turn);
      if (started.has(key)) return false;
      started.add(key);
      return true;
    },
    hasStarted(sessionId, turn) {
      return started.has(turnKey(sessionId, turn));
    },
    /** @returns {boolean} 第一次见到该 turn/end 时为 true。 */
    endTurn(sessionId, turn) {
      const key = turnKey(sessionId, turn);
      const fresh = !ended.has(key);
      ended.add(key);
      // 只见到 end 没见到 start（快照裁剪 / 断线）也算曾经开始过。
      started.add(key);
      return fresh;
    },
    hasEnded(sessionId, turn) {
      return ended.has(turnKey(sessionId, turn));
    },
    /** @returns {boolean} 第一次为该回合发 ForeignTurn 时为 true。 */
    markForeign(sessionId, turn) {
      const key = turnKey(sessionId, turn);
      if (foreign.has(key)) return false;
      foreign.add(key);
      return true;
    },
    isForeign(sessionId, turn) {
      return foreign.has(turnKey(sessionId, turn));
    },
    hasSeen(sessionId, turn) {
      const key = turnKey(sessionId, turn);
      return started.has(key) || ended.has(key) || foreign.has(key);
    },
    size() {
      return { started: started.size, ended: ended.size, foreign: foreign.size };
    },
  };
}

/**
 * 从 assistant/message 事件里取消息去重键。
 *
 * 优先用原生 message id；没有 id 时退回事件 seq。两者都缺时返回 null，
 * 调用方只能按「无法去重」处理（宁可重复一次，也不能吞掉正文）。
 *
 * @param {{data?: Object, seq?: number|string, id?: string}} event
 * @returns {string|null}
 */
export function messageKeyFor(event) {
  const data = event?.data ?? {};
  const messageId = data?.message?.id ?? data?.messageId;
  if (typeof messageId === 'string' && messageId.length > 0) return `id:${messageId}`;
  if (typeof messageId === 'number' && Number.isFinite(messageId)) return `id:${messageId}`;
  const seq = event?.seq;
  if (typeof seq === 'number' && Number.isFinite(seq)) return `seq:${seq}`;
  if (typeof seq === 'string' && seq.length > 0) return `seq:${seq}`;
  return null;
}
