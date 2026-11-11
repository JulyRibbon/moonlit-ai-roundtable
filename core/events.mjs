import { randomUUID } from 'node:crypto';

export const EVENT_SCHEMA_VERSION = 1;

export const BRIDGE_EVENT_TYPES = Object.freeze({
  ATTEMPT_STARTED: 'AttemptStarted',
  ATTEMPT_COMPLETED: 'AttemptCompleted',
  ATTEMPT_ABORTED: 'AttemptAborted',
  ATTEMPT_FAILED: 'AttemptFailed',
  FOREIGN_TURN: 'ForeignTurn',
  USAGE_REPORTED: 'UsageReported',
  SPEECH_STARTED: 'SpeechStarted',
  SPEECH_FINISHED: 'SpeechFinished',
  SPEECH_FAILED: 'SpeechFailed',
  BRIDGE_ERROR: 'BridgeError',
  BRIDGE_CLOSED: 'BridgeClosed',
});

export const ROOM_EVENT_TYPES = Object.freeze({
  ROOM_CREATED: 'RoomCreated',
  ROOM_STATE_CHANGED: 'RoomStateChanged',
  MESSAGE_POSTED: 'MessagePosted',
  TURN_REQUESTED: 'TurnRequested',
  MEMBER_THINKING: 'MemberThinking',
  MEMBER_RESPONDED: 'MemberResponded',
  MEMBER_PASSED: 'MemberPassed',
  MEMBER_FAILED: 'MemberFailed',
  SPEECH_STARTED: 'SpeechStarted',
  SPEECH_FINISHED: 'SpeechFinished',
  SPEECH_FAILED: 'SpeechFailed',
  HALT_REQUESTED: 'HaltRequested',
  HALT_SETTLED: 'HaltSettled',
  REVIEW_REQUESTED: 'ReviewRequested',
  RESULT_CONFIRMED: 'ResultConfirmed',
  SETTINGS_CHANGED: 'SettingsChanged',
  COUNTERS_RESET: 'CountersReset',
  TRANSCRIPT_CLEARED: 'TranscriptCleared',
  SEAT_SESSION_CHANGED: 'SeatSessionChanged',
});

const BRIDGE_EVENT_NAMES = new Set(Object.values(BRIDGE_EVENT_TYPES));
const ROOM_EVENT_NAMES = new Set(Object.values(ROOM_EVENT_TYPES));

export function createBridgeEvent({ type, seatId, attemptId = null, payload = {}, eventId, occurredAt }) {
  if (!BRIDGE_EVENT_NAMES.has(type)) {
    throw new TypeError(`Unknown bridge event type: ${type}`);
  }
  if (typeof seatId !== 'string' || seatId.length === 0) {
    throw new TypeError('Bridge event requires seatId.');
  }
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: eventId ?? `be_${randomUUID()}`,
    type,
    seatId,
    attemptId,
    occurredAt: occurredAt ?? new Date().toISOString(),
    payload,
  };
}

export function createRoomEvent({ type, roomId, roomSeq, actor, payload = {}, eventId, occurredAt }) {
  if (!ROOM_EVENT_NAMES.has(type)) {
    throw new TypeError(`Unknown room event type: ${type}`);
  }
  if (typeof roomId !== 'string' || roomId.length === 0) {
    throw new TypeError('Room event requires roomId.');
  }
  if (!Number.isSafeInteger(roomSeq) || roomSeq < 1) {
    throw new TypeError('Room event requires roomSeq >= 1.');
  }
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new TypeError('Room event requires actor.');
  }
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: eventId ?? `re_${randomUUID()}`,
    type,
    roomId,
    roomSeq,
    occurredAt: occurredAt ?? new Date().toISOString(),
    actor,
    payload,
  };
}
