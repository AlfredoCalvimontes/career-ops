// tests/doctor-git-locale.test.mjs — `doctor` must not depend on git's message language.
//
// checkTrackedBakFiles tells "not a git checkout" (expected, a clean skip) from a
// real failure by matching git's stderr. Under a non-English system locale git
// localizes that message (Spanish: "no es un repositorio git"), the English
// regex missed it, and the expected skip surfaced as a "check could not run"
// warning — which broke tests that assert a warning-free run. A user's language
// is data, not a reason for a different code path, so the git child's locale is
// pinned and this test runs doctor under a non-English locale to hold it there.
//
// If the named locale is not installed git falls back to English and the test
// passes trivially; it only has teeth where the locale exists.
//
// Run:  node --test tests/doctor-git-locale.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('outside a git checkout, doctor reports a clean skip under a Spanish locale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-doctor-locale-'));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'doctor.mjs'), '--json', '--target', dir], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 60_000,
      env: {
        ...process.env,
        CAREER_OPS_ROOT: dir,
        CAREER_OPS_DATA_DIR: '',
        LC_ALL: 'es_ES.UTF-8',
        LANG: 'es_ES.UTF-8',
        LANGUAGE: 'es',
      },
    });
    assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
    const state = JSON.parse(r.stdout);
    const bak = (state.warnings || []).filter((w) => /Tracked \.bak files/.test(w));
    assert.deepEqual(bak, [], `localized git message leaked into a warning: ${JSON.stringify(bak)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  }
});
