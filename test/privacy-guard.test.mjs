// The privacy guard, and the rules it enforces on the tracked tree.
//
// This file and scripts/privacy-guard.mjs are the only two paths the guard skips, because both
// have to contain the very strings it refuses. That skip list is asserted below so it cannot
// grow quietly, which is the only thing that would make the guard meaningless.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanText, scan, SKIPPED_PATHS, SYNTHETIC_DOMAINS } from '../scripts/privacy-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Assembled from parts so this file's own samples cannot be mistaken for the real thing by a
// human skim, and so the patterns below are the guard's, not copies of them.
const REAL_EMAIL = ['dana.ruiz', '@', 'acmerobotics', '.com'].join('');
const PHONE = ['555', '-', '018', '-', '4477'].join('');
const HOME_PATH = ['/User', 's/', 'someone', '/Projects/thing'].join('');

test('the skip list is exactly the guard and its own test', () => {
  assert.deepEqual([...SKIPPED_PATHS].sort(), ['scripts/privacy-guard.mjs', 'test/privacy-guard.test.mjs']);
});

test('the synthetic allowlist is the documented set and nothing else', () => {
  assert.deepEqual([...SYNTHETIC_DOMAINS].sort(), ['example.com', 'example.net', 'example.org', 'invalid', 'localhost', 'test']);
});

// --- emails ------------------------------------------------------------------------------

test('an email at a real-looking domain is refused anywhere, fixtures included', () => {
  const findings = scanText('fixtures/whatever.json', `{"to":"${REAL_EMAIL}"}`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'EMAIL');
  assert.match(findings[0].detail, /acmerobotics/);
});

test('an email at a synthetic domain passes', () => {
  for (const domain of ['example.com', 'example.org', 'example.net', 'acme.test', 'nothing.invalid', 'localhost']) {
    assert.deepEqual(scanText('fixtures/x.json', `{"to":"someone@${domain}"}`), [], domain);
  }
});

test('a subdomain of a synthetic domain passes', () => {
  assert.deepEqual(scanText('docs/x.md', 'mail@people.acme.test'), []);
});

// --- phone numbers -----------------------------------------------------------------------

test('a phone-shaped string outside fixtures is refused', () => {
  const findings = scanText('README.md', `call ${PHONE} for details`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'PHONE');
});

test('the same string inside fixtures is allowed, because a fixture is synthetic by rule', () => {
  assert.deepEqual(scanText('fixtures/leads.json', `{"phone":"${PHONE}"}`), []);
});

test('an ISO timestamp is not a phone number', () => {
  // The guard runs over a repo whose every fixture is full of these. A pattern that flagged
  // them would be turned off within a day, which is the real failure mode of a strict guard.
  for (const sample of ['2026-09-26T10:05:00.000Z', '2026-09-26', '10:05:00', '1758888000000']) {
    assert.deepEqual(scanText('README.md', sample), [], sample);
  }
});

test('a commit sha and a port number are not phone numbers', () => {
  for (const sample of ['4f1c9ab6d2e30517c8a1b4d9f0e6a2c37b58d194', 'http://localhost:5678', 'exit 127']) {
    assert.deepEqual(scanText('src/x.mjs', sample), [], sample);
  }
});

// --- home paths --------------------------------------------------------------------------

test('an absolute home path is refused anywhere', () => {
  // A prior lane in this vault shipped personal paths into a public tree. This is that rule.
  const findings = scanText('docs/SPEC.md', `the worktree lives at ${HOME_PATH}`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'HOME_PATH');
});

test('a linux home path is refused too', () => {
  const findings = scanText('README.md', ['/hom', 'e/', 'someone', '/repo'].join(''));
  assert.equal(findings[0].rule, 'HOME_PATH');
});

test('a relative path that merely mentions users is not a home path', () => {
  assert.deepEqual(scanText('README.md', 'see docs/users.md and /usr/local/bin/node'), []);
});

// --- the real tree -----------------------------------------------------------------------

test('the tracked tree is clean, which is the gate this repo actually ships behind', () => {
  const findings = scan(ROOT);
  assert.deepEqual(
    findings.map((finding) => `${finding.path}:${finding.line} ${finding.rule}`),
    [],
  );
});

test('the scan covers a meaningful number of files, so a clean result is not an empty scan', () => {
  const { scanned } = scan(ROOT, { withCount: true });
  assert.ok(scanned >= 15, `scanned ${scanned} files`);
});
