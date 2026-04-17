import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCoordinateInput } from '../dist/coordinates.js';

test('parseCoordinateInput accepts x and z pairs', () => {
  assert.deepEqual(parseCoordinateInput('123, -456'), {
    x: 123,
    y: null,
    z: -456,
  });
});

test('parseCoordinateInput accepts x, y, z triplets and ignores wrappers', () => {
  assert.deepEqual(parseCoordinateInput('[123, 64, -456]'), {
    x: 123,
    y: 64,
    z: -456,
  });
});

test('parseCoordinateInput rejects invalid coordinate strings', () => {
  assert.equal(parseCoordinateInput('abc'), null);
  assert.equal(parseCoordinateInput('1, 2, 3, 4'), null);
});
