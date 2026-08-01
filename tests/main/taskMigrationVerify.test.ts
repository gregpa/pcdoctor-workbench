// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { taskManifest } from '../../src/shared/taskManifest.js';
import { verifyTaskManifestMigration } from '../../src/main/taskMigrationVerify.js';

const HASH = 'a'.repeat(64);

function validResult() {
  return {
    success: true,
    source_sha256: HASH,
    results: taskManifest.tasks.map(task => ({
      id: task.id,
      name: task.name,
      state: task.state,
      status: task.state === 'active' ? 'registered' : 'absent',
    })),
  };
}

describe('verifyTaskManifestMigration', () => {
  it('accepts the exact full manifest result and expected source hash', () => {
    expect(verifyTaskManifestMigration(validResult(), HASH)).toBe(true);
  });

  it('accepts already_registered active rows and removed inactive rows', () => {
    const result = validResult();
    for (const row of result.results) {
      row.status = row.state === 'active' ? 'already_registered' : 'removed';
    }
    expect(verifyTaskManifestMigration(result, HASH)).toBe(true);
  });

  it.each([
    ['missing row', (result: ReturnType<typeof validResult>) => { result.results.pop(); }],
    ['wrong name', (result: ReturnType<typeof validResult>) => { result.results[0].name = 'PCDoctor-Wrong'; }],
    ['wrong state', (result: ReturnType<typeof validResult>) => { result.results[0].state = 'remove'; }],
    ['failed active row', (result: ReturnType<typeof validResult>) => { result.results[0].status = 'failed'; }],
    ['registered removal row', (result: ReturnType<typeof validResult>) => {
      const row = result.results.find(candidate => candidate.state === 'remove');
      if (row) row.status = 'registered';
    }],
  ])('rejects %s', (_label, mutate) => {
    const result = validResult();
    mutate(result);
    expect(verifyTaskManifestMigration(result, HASH)).toBe(false);
  });

  it('rejects unsuccessful, malformed, stale-hash, and absent results', () => {
    expect(verifyTaskManifestMigration({ ...validResult(), success: false }, HASH)).toBe(false);
    expect(verifyTaskManifestMigration({ ...validResult(), source_sha256: 'bad' }, HASH)).toBe(false);
    expect(verifyTaskManifestMigration(validResult(), 'b'.repeat(64))).toBe(false);
    expect(verifyTaskManifestMigration(null, HASH)).toBe(false);
    expect(verifyTaskManifestMigration(undefined, HASH)).toBe(false);
    expect(verifyTaskManifestMigration({}, HASH)).toBe(false);
  });
});
