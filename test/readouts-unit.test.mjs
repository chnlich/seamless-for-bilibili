import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READOUTS_VERSION, buildReadouts } from '../src/extension/readouts.js';

function ranges(values) {
  return {
    length: values.length,
    start(index) { return values[index][0]; },
    end(index) { return values[index][1]; },
  };
}

function video({ currentTime = 10, buffered = [[0, 80]] } = {}) {
  return {
    currentTime,
    buffered: ranges(buffered),
    seekable: ranges([[0, 120]]),
    src: 'https://media.example/video-1.m3u8',
    currentSrc: 'https://media.example/video-1.m3u8',
  };
}

test('readouts expose the continuous forward seconds against the current playhead', () => {
  const readouts = buildReadouts({
    surfaceId: 'surface-test',
    video: video({ currentTime: 10, buffered: [[0, 80], [90, 120]] }),
    diagnostics: { sessionId: 'session-test', routeKind: 'video' },
  });
  assert.equal(readouts.version, READOUTS_VERSION);
  assert.equal(readouts.forwardSeconds, 70);
  assert.deepEqual(readouts.diagnostics, { sessionId: 'session-test' });
  assert.equal(readouts.routeKind, 'video');
});

test('readouts keep going without a video element or without covering buffer', () => {
  const withoutVideo = buildReadouts({
    surfaceId: 'surface-test',
    video: undefined,
    diagnostics: { sessionId: 'session-test', routeKind: 'other' },
  });
  assert.equal(withoutVideo.forwardSeconds, '未提供');
  const emptyBuffer = buildReadouts({
    surfaceId: 'surface-test',
    video: video({ currentTime: 85, buffered: [[0, 80], [90, 120]] }),
    diagnostics: { sessionId: 'session-test', routeKind: 'video' },
  });
  assert.equal(emptyBuffer.forwardSeconds, 0);
});

test('readouts carry the session id the popup needs for cdn summaries', () => {
  const readouts = buildReadouts({
    surfaceId: 'surface-test',
    video: video(),
    diagnostics: undefined,
  });
  assert.equal(readouts.diagnostics.sessionId, '未提供');
  assert.equal(readouts.routeKind, '未提供');
  assert.equal(Object.hasOwn(readouts, 'bank'), false);
  assert.equal(Object.hasOwn(readouts, 'lastStall'), false);
  assert.equal(Object.hasOwn(readouts, 'media'), false);
});
