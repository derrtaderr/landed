#!/usr/bin/env node
// The privacy guard. docs/SPEC.md §3G.
//
// Three rules over the tracked tree:
//
//   EMAIL      an address whose domain is not in the synthetic allowlist, ANYWHERE, fixtures
//              included. A fixture is supposed to be invented, so a real-looking address in one
//              is the finding, not the exception.
//   PHONE      a phone-shaped string outside fixtures/.
//   HOME_PATH  an absolute home-directory path, anywhere. A prior lane in this vault shipped
//              personal paths into a public tree; this rule is that lane's scar.
//
// This file and test/privacy-guard.test.mjs are the only skipped paths, because both must contain
// the strings the guard refuses. That list is asserted in the test so it cannot grow quietly,
// which is the only thing that would make the guard meaningless.
//
// The shape is copied from public precedents (a tracked-file scanner run as a gate, not a hook);
// the rules and the patterns are this repo's own.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';

export const SKIPPED_PATHS = new Set(['scripts/privacy-guard.mjs', 'test/privacy-guard.test.mjs']);

// Domains reserved for documentation and testing, plus the two reserved TLDs. Anything else is a
// domain that might belong to somebody.
export const SYNTHETIC_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test', 'invalid', 'localhost']);

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost)/g;

// Deliberately specific groupings. A looser pattern matches every ISO timestamp in the fixture
// corpus, and a guard that cries wolf on its own fixtures is a guard somebody turns off.
const PHONE_PATTERNS = [
  /\(\d{3}\)\s*\d{3}[ -]\d{4}/g,
  /\b\d{3}-\d{3}-\d{4}\b/g,
  /\b\d{3}\.\d{3}\.\d{4}\b/g,
  /\+\d{1,3}[ -]\(?\d{2,4}\)?[ -]\d{3,4}[ -]\d{3,4}\b/g,
];

const HOME_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g;

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'landed', 'landed-demo']);

function isSynthetic(domain) {
  const lower = domain.toLowerCase();
  if (SYNTHETIC_DOMAINS.has(lower)) return true;
  // A subdomain of a synthetic domain, and the two reserved TLDs.
  for (const allowed of SYNTHETIC_DOMAINS) {
    if (lower.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

// One file's worth of findings. Exported so the test can feed it a sample without writing one to
// disk, which would be a file the guard then has to skip.
export function scanText(path, text) {
  const findings = [];
  const normalized = path.split(sep).join('/');
  if (SKIPPED_PATHS.has(normalized)) return findings;

  const inFixtures = normalized.startsWith('fixtures/') || normalized.includes('/fixtures/');
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    for (const match of line.matchAll(EMAIL)) {
      if (!isSynthetic(match[1])) {
        findings.push({ path: normalized, line: index + 1, rule: 'EMAIL', detail: `${match[0]} is at a domain that is not reserved for documentation` });
      }
    }

    if (!inFixtures) {
      for (const pattern of PHONE_PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          findings.push({ path: normalized, line: index + 1, rule: 'PHONE', detail: `${match[0]} looks like a telephone number, outside fixtures/` });
        }
      }
    }

    for (const match of line.matchAll(HOME_PATH)) {
      findings.push({ path: normalized, line: index + 1, rule: 'HOME_PATH', detail: `${match[0]} is an absolute home-directory path` });
    }
  }

  return findings;
}

// The tracked files, from git when it is available and from a walk when it is not, so the guard
// still runs inside a tarball or a fresh copy with no history.
export function trackedFiles(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : walk(join(dir, entry.name));
        return [relative(root, join(dir, entry.name)).split(sep).join('/')];
      });
    return walk(root);
  }
}

const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|pdf|zip|ico|woff2?|mp4)$/i;

export function scan(root, { withCount = false } = {}) {
  const findings = [];
  let scanned = 0;

  for (const path of trackedFiles(root)) {
    if (BINARY_EXTENSIONS.test(path)) continue;
    const full = join(root, path);
    if (!existsSync(full)) continue;

    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }

    scanned += 1;
    findings.push(...scanText(path, text));
  }

  return withCount ? { findings, scanned } : findings;
}

// Run as a gate.
if (process.argv[1] !== undefined && process.argv[1].endsWith('privacy-guard.mjs')) {
  const root = process.argv[2] ?? process.cwd();
  const { findings, scanned } = scan(root, { withCount: true });

  if (findings.length === 0) {
    console.log(`privacy guard: ${scanned} tracked files, nothing to report`);
    process.exitCode = 0;
  } else {
    for (const finding of findings) {
      console.error(`${finding.path}:${finding.line}  ${finding.rule}  ${finding.detail}`);
    }
    console.error('');
    console.error(`privacy guard: ${findings.length} finding(s) in ${scanned} tracked files`);
    process.exitCode = 1;
  }
}
