import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TABLETOP_ENGINES,
  TABLETOP_TYPES,
  TabletopEngineError,
  getTabletopEngine,
  isTabletopType,
} from '../../games/tabletop/engine.mjs';

test('TABLETOP_TYPES lists the five independent games in a stable order', () => {
  assert.deepEqual([...TABLETOP_TYPES], ['xiangqi', 'chess', 'go', 'gomoku', 'reversi']);
  assert.deepEqual(Object.keys(TABLETOP_ENGINES).sort(), [...TABLETOP_TYPES].sort());
});

test('getTabletopEngine returns the shared module for each type', () => {
  for (const type of TABLETOP_TYPES) {
    const engine = getTabletopEngine(type);
    assert.equal(engine, TABLETOP_ENGINES[type]);
    assert.equal(engine.GAME_TYPE, type);
    assert.equal(isTabletopType(type), true);
  }
});

test('getTabletopEngine rejects unknown or malformed types explicitly', () => {
  for (const value of ['shogi', '', null, undefined, 42]) {
    assert.throws(
      () => getTabletopEngine(value),
      (error) => {
        assert.ok(error instanceof TabletopEngineError);
        assert.equal(error.code, 'TABLETOP_TYPE_UNKNOWN');
        assert.match(error.message, /未知的桌面对局类型/);
        return true;
      },
    );
  }
  assert.equal(isTabletopType('shogi'), false);
});

for (const type of TABLETOP_TYPES) {
  test(`${type}: unified interface can create, list, apply and render a position`, () => {
    const engine = getTabletopEngine(type);

    for (const name of [
      'createPosition',
      'normalizeAction',
      'applyTurn',
      'listLegalActions',
      'positionToText',
      'getBoardView',
    ]) {
      assert.equal(typeof engine[name], 'function', `${type}.${name}`);
    }

    const position = engine.createPosition();
    assert.equal(position.currentPlayer, 0);
    assert.equal(position.status, 'playing');
    assert.equal(Array.isArray(position.winners), true);
    assert.equal(Array.isArray(position.scores), true);
    assert.equal(position.scores.length, 2);

    const legal = engine.listLegalActions(position);
    assert.ok(legal.length > 0, `${type} must have opening moves`);
    const action = legal[0];
    assert.deepEqual(engine.normalizeAction(action), action);

    const next = engine.applyTurn(position, { player: position.currentPlayer, action });
    assert.ok(['playing', 'finished'].includes(next.status));
    assert.equal((next.moves?.length ?? 0) >= 1 || type === 'gomoku', true);

    const view = engine.getBoardView(position);
    assert.ok(view.rows > 0);
    assert.ok(view.columns > 0);
    assert.equal(view.cells.length, view.rows * view.columns);
    assert.equal(typeof engine.positionToText(position), 'string');
    assert.ok(engine.positionToText(position).length > 0);

    assert.throws(
      () => engine.normalizeAction(null),
      (error) => error?.name === 'GameRuleError' || typeof error?.code === 'string',
    );
    assert.throws(
      () => engine.normalizeAction('not-an-action'),
      (error) => error?.name === 'GameRuleError' || typeof error?.code === 'string',
    );
  });
}

test('positions from different engines stay independent', () => {
  const engine = getTabletopEngine('gomoku');
  const initial = engine.createPosition();
  const go = getTabletopEngine('go').createPosition();
  const action = engine.listLegalActions(initial)[0];
  const next = engine.applyTurn(initial, { player: 0, action });

  assert.deepEqual(go.board, Array.from({ length: 9 }, () => Array(9).fill(null)));
  assert.equal(initial.board[0][0], null);
  assert.equal(next.board[0][0], 0);
});
