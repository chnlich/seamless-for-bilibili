import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BANK_CONFIG } from '../src/constants.js';
import { SegmentBank } from '../src/bank/main.js';
import { INVENTORY_HEARTBEAT_FLOOR_MS, deriveBankInventory } from '../src/bank/inventory.js';
import { sanitizeEventData } from '../src/diagnostics/privacy.js';

const MEDIA_URL = 'https://cdn-a.example/video/track.m4s?signature=secret';
const RESOURCE = '/video/track.m4s';

function bankFixture({ now = 0, configuredEnabled, config = { ...BANK_CONFIG, chunkBytes: 16 } } = {}) {
  let clock = now;
  let tick;
  const messages = [];
  const windowObject = {
    location: new URL('https://www.bilibili.com/video/BVinventory'),
    document: {
      documentElement: {
        getAttribute() {
          return configuredEnabled;
        },
      },
    },
    setInterval(callback) {
      tick = callback;
      return 1;
    },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    performance: { now: () => clock },
    postMessage(message) { messages.push(message); },
  };
  const bank = new SegmentBank({
    windowObject,
    nativeFetch: async () => { throw new Error('inventory test does not fetch'); },
    config,
    now: () => clock,
  });
  return {
    bank,
    messages,
    tick() {
      assert.notEqual(tick, undefined);
      tick();
    },
    setNow(value) { clock = value; },
    setLocation(value) { windowObject.location = new URL(value); },
  };
}

function inventoryMessages(fixture) {
  return fixture.messages.filter((message) => message.code === 'bank.inventory');
}

test('inventory derivation reports an empty bank and missing total size without inventing values', () => {
  const fixture = bankFixture();
  const empty = deriveBankInventory({
    chunks: new Map(),
    chunkBytes: 1_048_576,
    resourceState: new Map(),
    addressBook: new Map(),
    recentResourceKeys: [],
    maxBankBytes: 512,
    maxPrefetchConcurrency: 4,
    queueLength: 0,
    inflightCount: 0,
    disabled: false,
    routeActive: true,
    isPairedAddressAvailable: () => false,
    sessionGeneration: 0,
  });
  assert.equal(empty.storedBytes, 0);
  assert.equal(empty.storedChunks, 0);
  assert.deepEqual(empty.resources, []);

  const state = fixture.bank.stateFor(RESOURCE);
  state.latestUrl = MEDIA_URL;
  fixture.bank.touchResource(RESOURCE);
  fixture.bank.publishInventory(true);
  const resource = inventoryMessages(fixture).at(-1).data.resources[0];
  assert.equal(resource.totalSize, '未提供');
  assert.equal(resource.lastForegroundEnd, '未提供');
  assert.equal(resource.active, true);
  fixture.bank.destroy();
});

test('inventory reports absent paired address, disabled state, and route-left release', () => {
  const fixture = bankFixture({ configuredEnabled: 'false' });
  const state = fixture.bank.stateFor(RESOURCE);
  state.latestUrl = MEDIA_URL;
  fixture.bank.touchResource(RESOURCE);
  fixture.bank.addressBook.set(RESOURCE, {
    urls: [MEDIA_URL],
    observedAt: 0,
    representation: { mimeType: 'video/mp4', height: 720, codecs: 'avc1', bandwidth: 1000 },
    label: '720P',
  });

  fixture.tick();
  const disabled = inventoryMessages(fixture).at(-1).data;
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.pairedAddressAvailable, false);

  fixture.setLocation('https://www.bilibili.com/search');
  fixture.tick();
  const routeLeft = inventoryMessages(fixture).at(-1).data;
  assert.equal(routeLeft.routeActive, false);
  assert.equal(routeLeft.storedBytes, 0);
  assert.equal(routeLeft.resources.length, 0);
  assert.equal(routeLeft.sessionGeneration, 1);
  fixture.bank.destroy();
});

test('inventory excludes representations that exist only in the address book', () => {
  const addressBookOnly = '/video/address-book-only.m4s';
  const inventory = deriveBankInventory({
    chunks: new Map(),
    chunkBytes: 1_048_576,
    resourceState: new Map(),
    addressBook: new Map([[addressBookOnly, {
      representation: { mimeType: 'video/mp4', height: 360 },
      label: '360P',
    }]]),
    recentResourceKeys: [],
    maxBankBytes: 512,
    maxPrefetchConcurrency: 4,
    queueLength: 0,
    inflightCount: 0,
    disabled: false,
    routeActive: true,
    isPairedAddressAvailable: () => false,
    sessionGeneration: 0,
  });

  assert.deepEqual(inventory.resources, []);
});

test('inventory keeps a requested representation with zero stored bytes', () => {
  const inventory = deriveBankInventory({
    chunks: new Map(),
    chunkBytes: 1_048_576,
    resourceState: new Map([[RESOURCE, {
      totalSize: undefined,
      lastForegroundEnd: undefined,
      outstanding: new Set(),
      chunkAttempts: new Map(),
    }]]),
    addressBook: new Map([[RESOURCE, {
      representation: { mimeType: 'video/mp4', height: 720 },
      label: '720P',
    }]]),
    recentResourceKeys: [RESOURCE],
    maxBankBytes: 512,
    maxPrefetchConcurrency: 4,
    queueLength: 0,
    inflightCount: 0,
    disabled: false,
    routeActive: true,
    isPairedAddressAvailable: () => false,
    sessionGeneration: 0,
  });

  assert.equal(inventory.resources.length, 1);
  assert.equal(inventory.resources[0].pathname, RESOURCE);
  assert.equal(inventory.resources[0].storedBytes, 0);
  assert.equal(inventory.resources[0].storedChunks, 0);
});

test('unchanged inventory is suppressed until the heartbeat floor republishes it', async () => {
  const fixture = bankFixture();
  await fixture.bank.prefetch();
  await fixture.bank.prefetch();
  assert.equal(inventoryMessages(fixture).length, 1);

  fixture.setNow(INVENTORY_HEARTBEAT_FLOOR_MS - 1);
  await fixture.bank.prefetch();
  assert.equal(inventoryMessages(fixture).length, 1);

  fixture.setNow(INVENTORY_HEARTBEAT_FLOOR_MS);
  await fixture.bank.prefetch();
  assert.equal(inventoryMessages(fixture).length, 2);
  fixture.bank.destroy();
});

test('inventory resources are sanitized to pathnames and never retain query or hash', () => {
  const sanitized = sanitizeEventData('bank.inventory', {
    sessionGeneration: 1,
    storedBytes: 10,
    storedChunks: 1,
    maxBankBytes: 512,
    queued: 0,
    inflight: 0,
    prefetchConcurrency: 4,
    disabled: false,
    routeActive: true,
    pairedAddressAvailable: true,
    resources: [{
      pathname: '/video/track.m4s?deadline=secret#fragment',
      kind: 'video',
      label: '1080P 高清',
      height: 1080,
      codecs: 'avc1.640028',
      bandwidth: 5000000,
      storedBytes: 10,
      storedChunks: 1,
      totalSize: 100,
      contiguousEnd: 64,
      lastForegroundEnd: 15,
      outstanding: 0,
      retrying: 0,
      active: true,
      secret: 'removed',
    }],
  });
  assert.equal(sanitized.resources[0].pathname, '/video/track.m4s');
  assert.equal(sanitized.resources[0].contiguousEnd, 64);
  assert.doesNotMatch(JSON.stringify(sanitized), /deadline=secret|fragment|secret/);
  assert.equal(Object.hasOwn(sanitized.resources[0], 'secret'), false);
});

function contiguousEndFixture(state, storedIndices, { chunkBytes = 1024 } = {}) {
  const chunks = new Map(
    [...storedIndices].map((index) => [`${RESOURCE}#${index}`, { bytes: new ArrayBuffer(1) }]),
  );
  return deriveBankInventory({
    chunks,
    chunkBytes,
    resourceState: new Map([[RESOURCE, {
      bankKey: RESOURCE,
      outstanding: new Set(),
      chunkAttempts: new Map(),
      ...state,
    }]]),
    addressBook: new Map(),
    recentResourceKeys: [RESOURCE],
    maxBankBytes: 512,
    maxPrefetchConcurrency: 4,
    queueLength: 0,
    inflightCount: 0,
    disabled: false,
    routeActive: true,
    isPairedAddressAvailable: () => false,
    sessionGeneration: 0,
  }).resources[0];
}

test('contiguousEnd stops at the first missing chunk after the anchor', () => {
  // 已存 0、1、4，第 2 块缺着：中间的空洞截断连续范围，后面存得再多也播不到。
  const resource = contiguousEndFixture(
    { totalSize: 5632, outstanding: new Set([{ start: 2048 }, { start: 512 }]) },
    new Set([0, 1, 4]),
  );
  assert.equal(resource.contiguousEnd, 2048);
  assert.equal(resource.storedChunks, 3);
});

test('contiguousEnd reaches totalSize when the run covers the whole file', () => {
  const resource = contiguousEndFixture(
    { totalSize: 5120, outstanding: new Set([{ start: 0 }]) },
    new Set([0, 1, 2, 3, 4]),
  );
  assert.equal(resource.contiguousEnd, 5120);
});

test('contiguousEnd falls back to the last player request start when nothing is outstanding', () => {
  const resource = contiguousEndFixture(
    { totalSize: 5632, lastForegroundStart: 4096 },
    new Set([4]),
  );
  assert.equal(resource.contiguousEnd, 5120);
});

test('contiguousEnd is omitted while the anchor or the total size is unknown', () => {
  const unknownAnchor = contiguousEndFixture({ totalSize: 5632 }, new Set([0]));
  assert.equal(Object.hasOwn(unknownAnchor, 'contiguousEnd'), false);
  const unknownTotal = contiguousEndFixture({ outstanding: new Set([{ start: 0 }]) }, new Set([0]));
  assert.equal(unknownTotal.totalSize, '未提供');
  assert.equal(Object.hasOwn(unknownTotal, 'contiguousEnd'), false);
});

test('contiguousEnd from the bank goes through publishInventory with the configured chunk size', async () => {
  const fixture = bankFixture();
  const state = fixture.bank.stateFor(RESOURCE);
  state.latestUrl = MEDIA_URL;
  state.totalSize = 48;
  state.lastForegroundStart = 16;
  fixture.bank.chunks.set(`${RESOURCE}#1`, { bytes: new ArrayBuffer(16) });
  fixture.bank.chunks.set(`${RESOURCE}#2`, { bytes: new ArrayBuffer(16) });
  const published = fixture.bank.publishInventory(true);
  assert.equal(published, true);
  // 测试配置的 chunkBytes 是 16：播放器请求的起点在块 1，已存块 1、2 连续到文件末尾。
  const resource = inventoryMessages(fixture).at(-1).data.resources[0];
  assert.equal(resource.contiguousEnd, 48);
  fixture.bank.destroy();
});
