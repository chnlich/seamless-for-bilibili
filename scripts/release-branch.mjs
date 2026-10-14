// Creates the GitHub branch release/<version> for a store submission.
//
// The branch marks the commit that produced the uploaded zip, as recorded by
// npm run package in release/seamless-for-bilibili-<version>.commit; the rule
// text lives in store/README.md ## 版本分支. The push below uses the
// create-only lease form: with an empty expected value, --force-with-lease
// requires the remote ref to not exist, so no run of this command can move an
// existing branch.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const BUILD_ID_PATTERN = /src-[0-9a-f]{24}/g;

// process.exit can drop messages still queued on a piped stdout; write
// through the synchronous file descriptor instead.
function printOut(line) {
  fs.writeSync(1, `${line}\n`);
}

function fail(reason) {
  fs.writeSync(2, `release:branch: ${reason}\n`);
  process.exit(1);
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`cannot run git ${args[0]}: ${result.error.message}`);
  return result;
}

function gitStdout(args, reason) {
  const result = git(args);
  if (result.status !== 0) fail(`${reason}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function parseArguments(argv) {
  let zip;
  let commit;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--zip') {
      zip = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--commit') {
      commit = argv[index + 1];
      index += 1;
    } else {
      fail(`unknown argument "${argv[index]}"; usage: npm run release:branch [-- --zip <zip path> --commit <commit>]`);
    }
  }
  if (zip !== undefined && !zip) fail('--zip needs a zip path');
  if (commit !== undefined && !commit) fail('--commit needs a 40-character commit id');
  if ((zip === undefined) !== (commit === undefined)) {
    fail('--zip and --commit must be given together: a zip does not record the commit it was packaged from, and a commit alone does not name the uploaded zip');
  }
  return zip === undefined ? null : { zip, commit };
}

const explicit = parseArguments(process.argv.slice(2));

// Fetch first, so the membership and ls-remote checks below read GitHub's
// current state instead of a stale local view.
const fetchResult = git(['fetch', 'origin']);
if (fetchResult.status !== 0) fail(`git fetch origin failed: ${fetchResult.stderr.trim()}`);

let zipPath;
let commit;
if (explicit) {
  ({ zip: zipPath, commit } = explicit);
} else {
  const packageMetadata = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  zipPath = path.join('release', `seamless-for-bilibili-${packageMetadata.version}.zip`);
  const commitFile = path.join('release', `seamless-for-bilibili-${packageMetadata.version}.commit`);
  if (!fs.existsSync(commitFile)) {
    fail(`${commitFile} is missing; npm run package writes it next to the zip, so run npm run package for this version first`);
  }
  commit = fs.readFileSync(commitFile, 'utf8').trim();
}
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`recorded commit "${commit}" is not a 40-character commit id`);
if (!fs.existsSync(zipPath)) fail(`zip not found: ${zipPath}`);

const archive = new AdmZip(zipPath);
const manifestEntry = archive.getEntry('manifest.json');
if (!manifestEntry) fail(`${zipPath} has no root manifest.json`);
const version = JSON.parse(manifestEntry.getData().toString('utf8')).version;
if (typeof version !== 'string' || version === '') fail(`manifest.json in ${zipPath} has no version`);
const branch = `release/${version}`;
if (git(['check-ref-format', `refs/heads/${branch}`]).status !== 0) {
  fail(`"${branch}" (from the zip's manifest version "${version}") is not a valid branch name`);
}

const contains = gitStdout(['branch', '-r', '--contains', commit], `commit ${commit} is not an object in this repository`);
if (!contains.split('\n').some((line) => line.trim().startsWith('origin/'))) {
  fail(`recorded commit ${commit} is not on any branch of origin; push the branch that contains it before creating ${branch}`);
}

function readBuildIds(text, origin, context) {
  const ids = new Set([...text.matchAll(BUILD_ID_PATTERN)].map((match) => match[0]));
  if (ids.size === 0) fail(`no build id found in ${origin}${context}`);
  if (ids.size > 1) fail(`found ${ids.size} different build ids in ${origin}${context}: ${[...ids].join(', ')}`);
  return [...ids][0];
}

// The build id names the src/ tree the zip was packaged from; the recorded
// commit must hold the same one, so a zip made from another tree cannot take
// this commit's branch. A docs-only commit keeps the build id, which is why
// the branch still lands on the recorded commit.
let zipJavaScript = '';
for (const entry of archive.getEntries()) {
  if (entry.entryName.endsWith('.js')) zipJavaScript += `${entry.getData().toString('utf8')}\n`;
}
const zipBuildId = readBuildIds(zipJavaScript, `the js files of ${zipPath}`, '');
const controller = gitStdout(['show', `${commit}:dist/extension/controller.js`], `commit ${commit} has no dist/extension/controller.js`);
const commitBuildId = readBuildIds(controller, 'dist/extension/controller.js', ` at commit ${commit}`);
if (zipBuildId !== commitBuildId) {
  fail(`build id mismatch: ${zipPath} was packaged from build ${zipBuildId}, but commit ${commit} built ${commitBuildId}`);
}

const remote = gitStdout(['ls-remote', 'origin', `refs/heads/${branch}`], `cannot query ${branch} on origin`);
if (remote !== '') {
  const existing = remote.split(/\s+/)[0];
  if (existing === commit) {
    printOut(`${branch} already exists at ${commit}`);
    process.exit(0);
  }
  fail(`${branch} already exists at ${existing}, not at the recorded commit ${commit}; the branch is left unchanged`);
}

const push = git(['push', `--force-with-lease=refs/heads/${branch}:`, 'origin', `${commit}:refs/heads/${branch}`]);
if (push.status !== 0) {
  fail(`push rejected; ${branch} is left unchanged: ${push.stderr.trim()}`);
}
printOut(`created ${branch} at ${commit}`);
