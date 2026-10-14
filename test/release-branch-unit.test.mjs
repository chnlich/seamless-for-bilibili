import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'release-branch.mjs');
const BUILD_ID = `src-${'a'.repeat(24)}`;
const OTHER_BUILD_ID = `src-${'b'.repeat(24)}`;
const VERSION = '1.2.3';
const BRANCH = `release/${VERSION}`;

function gitEnv(extra = {}) {
  return { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extra };
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeWorld(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-branch-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const origin = path.join(directory, 'origin.git');
  const work = path.join(directory, 'work');
  fs.mkdirSync(work, { recursive: true });
  git(directory, ['init', '--bare', origin]);
  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'user.name', 'Unit Test']);
  git(work, ['config', 'user.email', 'unit-test@example.com']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['remote', 'add', 'origin', origin]);
  return { directory, origin, work };
}

function commitBuild(world, { version = VERSION, buildId = BUILD_ID } = {}) {
  fs.writeFileSync(path.join(world.work, 'package.json'), `${JSON.stringify({ name: 'seamless-for-bilibili', version })}\n`);
  fs.writeFileSync(path.join(world.work, '.gitignore'), 'release/\n');
  fs.mkdirSync(path.join(world.work, 'dist', 'extension'), { recursive: true });
  fs.writeFileSync(path.join(world.work, 'dist', 'extension', 'controller.js'), `const BUILT_BUILD_ID = "${buildId}";\n`);
  git(world.work, ['add', '.']);
  git(world.work, ['commit', '-m', 'build']);
  return git(world.work, ['rev-parse', 'HEAD']);
}

function commitDocs(world, message = 'docs only') {
  git(world.work, ['commit', '--allow-empty', '-m', message]);
  return git(world.work, ['rev-parse', 'HEAD']);
}

function pushMain(world) {
  git(world.work, ['push', 'origin', 'main']);
}

function makeZip({ version = VERSION, buildId = BUILD_ID } = {}) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(`${JSON.stringify({ manifest_version: 3, name: 'seamless-for-bilibili', version })}\n`));
  zip.addFile('controller.js', Buffer.from(`const BUILT_BUILD_ID = "${buildId}";\n`));
  zip.addFile('worker.js', Buffer.from(`const buildId = "${buildId}";\n`));
  return zip.toBuffer();
}

function writeReleaseFiles(world, { version = VERSION, buildId = BUILD_ID, commit = undefined } = {}) {
  const release = path.join(world.work, 'release');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, `seamless-for-bilibili-${version}.zip`), makeZip({ version, buildId }));
  if (commit !== undefined) {
    fs.writeFileSync(path.join(release, `seamless-for-bilibili-${version}.commit`), `${commit}\n`);
  }
}

function run(world, args = [], extraEnv = {}) {
  const result = spawnSync('node', [script, ...args], { cwd: world.work, encoding: 'utf8', env: gitEnv(extraEnv) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function remoteBranchCommit(world, branch = BRANCH) {
  const result = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: world.origin, encoding: 'utf8', env: gitEnv() });
  return result.status === 0 ? result.stdout.trim() : null;
}

test('creates the branch at the recorded commit, not at HEAD', (t) => {
  const world = makeWorld(t);
  const packaged = commitBuild(world);
  pushMain(world);
  writeReleaseFiles(world, { commit: packaged });
  const head = commitDocs(world, 'docs committed after packaging');
  assert.notEqual(head, packaged);

  const result = run(world);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(BRANCH));
  assert.ok(result.stdout.includes(packaged));
  assert.equal(remoteBranchCommit(world), packaged);
});

test('a second run reports the branch exists, exits 0, and pushes nothing', (t) => {
  const world = makeWorld(t);
  const packaged = commitBuild(world);
  pushMain(world);
  writeReleaseFiles(world, { commit: packaged });

  // Push attempts come from git's own trace, never from a PATH wrapper.
  const traceLog = path.join(world.directory, 'git-trace.log');
  const env = { GIT_TRACE: traceLog };

  const first = run(world, [], env);
  assert.equal(first.status, 0, first.stderr);
  const second = run(world, [], env);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(second.stdout.includes('already exists'));
  assert.ok(second.stdout.includes(BRANCH));
  assert.ok(second.stdout.includes(packaged));
  const pushes = fs.readFileSync(traceLog, 'utf8').split('\n').filter((line) => line.includes('built-in: git push'));
  assert.equal(pushes.length, 1);
  assert.equal(remoteBranchCommit(world), packaged);
});

test('fails when the .commit record is missing', (t) => {
  const world = makeWorld(t);
  commitBuild(world);
  pushMain(world);
  writeReleaseFiles(world);

  const result = run(world);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`seamless-for-bilibili-${VERSION}.commit`));
  assert.equal(remoteBranchCommit(world), null);
});

test('fails when the recorded commit is not on origin', (t) => {
  const world = makeWorld(t);
  commitBuild(world);
  pushMain(world);
  const unpushed = commitDocs(world, 'not yet pushed');
  writeReleaseFiles(world, { commit: unpushed });

  const result = run(world);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(unpushed));
  assert.ok(result.stderr.includes('origin'));
  assert.equal(remoteBranchCommit(world), null);
});

test('fails when the zip build id differs from the commit build id', (t) => {
  const world = makeWorld(t);
  const packaged = commitBuild(world);
  pushMain(world);
  writeReleaseFiles(world, { commit: packaged, buildId: OTHER_BUILD_ID });

  const result = run(world);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(BUILD_ID));
  assert.ok(result.stderr.includes(OTHER_BUILD_ID));
  assert.equal(remoteBranchCommit(world), null);
});

test('fails when the branch points to another commit', (t) => {
  const world = makeWorld(t);
  const packaged = commitBuild(world);
  pushMain(world);
  const newer = commitDocs(world);
  pushMain(world);
  git(world.origin, ['update-ref', `refs/heads/${BRANCH}`, newer]);
  writeReleaseFiles(world, { commit: packaged });

  const result = run(world);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(newer));
  assert.ok(result.stderr.includes(packaged));
  assert.equal(remoteBranchCommit(world), newer);
});

test('keeps the branch when it points to an ancestor of the recorded commit', (t) => {
  const world = makeWorld(t);
  const older = commitBuild(world);
  pushMain(world);
  const packaged = commitDocs(world, 'docs between packaging and submission');
  pushMain(world);
  git(world.origin, ['update-ref', `refs/heads/${BRANCH}`, older]);
  writeReleaseFiles(world, { commit: packaged });

  const result = run(world);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(older));
  assert.ok(result.stderr.includes(packaged));
  assert.equal(remoteBranchCommit(world), older);
});

test('accepts --zip and --commit together and rejects either one alone', (t) => {
  const world = makeWorld(t);
  const packaged = commitBuild(world);
  pushMain(world);

  const zipPath = path.join(world.work, 'uploaded.zip');
  fs.writeFileSync(zipPath, makeZip());

  const zipOnly = run(world, ['--zip', zipPath]);
  assert.equal(zipOnly.status, 1);
  assert.ok(zipOnly.stderr.includes('--zip') && zipOnly.stderr.includes('--commit'));
  const commitOnly = run(world, ['--commit', packaged]);
  assert.equal(commitOnly.status, 1);
  assert.ok(commitOnly.stderr.includes('--zip') && commitOnly.stderr.includes('--commit'));
  assert.equal(remoteBranchCommit(world), null);

  const created = run(world, ['--zip', zipPath, '--commit', packaged]);
  assert.equal(created.status, 0, created.stderr);
  assert.ok(created.stdout.includes(BRANCH));
  assert.ok(created.stdout.includes(packaged));
  assert.equal(remoteBranchCommit(world), packaged);
});
