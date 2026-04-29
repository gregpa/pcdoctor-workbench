// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * v2.5.7 (B1 readonly-DB hotfix): ensureSiblingDbAcl() in dataStore.ts is the
 * runtime self-heal for workbench.db-wal / workbench.db-shm inheriting
 * Users:(I)(RX) from the tier-A installer ACL on C:\ProgramData\PCDoctor.
 *
 * What this suite locks in:
 *   1. No-op when sibling files don't exist (fresh install pre-create case).
 *   2. No-op when ACL already grants Users:(M) -- the explicit-grant case.
 *   3. No-op when ACL grants Users:(I)(M) -- inherited Modify is fine.
 *   4. No-op when ACL grants Users:(F) or Users:(I)(F) -- Full covers Modify.
 *   5. RUNS icacls /grant when only Users:(I)(RX) -- the actual bug case.
 *   6. Logs warning and does not throw when icacls grant fails (no WRITE_DAC).
 *   7. Both wal AND shm are processed independently in one call.
 *   8. Conservative detection: (RX,W,D) without M/F still triggers grant.
 *
 * We mock node:child_process.execFileSync to feed synthetic icacls output
 * and observe call sequences. WORKBENCH_DB_PATH is mocked to a fixed
 * non-real path; existsSync is mocked per-test to control whether the
 * siblings "exist".
 */

const FAKE_DB = 'C:\\fake\\PCDoctor\\workbench.db';
const FAKE_WAL = `${FAKE_DB}-wal`;
const FAKE_SHM = `${FAKE_DB}-shm`;

vi.mock('../../src/main/constants.js', () => ({
  WORKBENCH_DB_PATH: FAKE_DB,
  PCDOCTOR_ROOT: 'C:\\fake\\PCDoctor',
  LATEST_JSON_PATH: 'C:\\fake\\PCDoctor\\reports\\latest.json',
  LOG_DIR: 'C:\\fake\\PCDoctor\\logs',
  resolvePwshPath: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  PWSH_FALLBACK: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  DEFAULT_SCRIPT_TIMEOUT_MS: 300_000,
  AUTOSTART_TASK_NAME: 'PCDoctor-Workbench-Autostart',
  POLL_INTERVAL_MS: 60_000,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => ''),
  };
});

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let ds: typeof import('../../src/main/dataStore.js');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ds = await import('../../src/main/dataStore.js');
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- Helpers -----------------------------------------------------------------

function mockExistsSyncFor(paths: string[]) {
  vi.mocked(existsSync).mockImplementation((p: any) =>
    paths.includes(String(p)),
  );
}

/**
 * Configure execFileSync to return per-file icacls output. The first arg to
 * execFileSync is 'icacls.exe', the second is [filepath] for reads or
 * [filepath, '/grant', ...] for writes.
 */
function mockIcacls(opts: {
  readResults: Record<string, string>;        // filepath -> icacls output
  grantThrows?: Record<string, Error>;        // filepath -> throw on /grant
}) {
  vi.mocked(execFileSync).mockImplementation((cmd: any, args: any) => {
    const argList = (args as string[]) ?? [];
    const filepath = argList[0];
    const isGrant = argList.includes('/grant');
    if (cmd !== 'icacls.exe') throw new Error(`unexpected cmd: ${cmd}`);

    if (isGrant) {
      const err = opts.grantThrows?.[filepath];
      if (err) throw err;
      return '' as any;  // icacls /grant prints summary; tests don't read it
    }
    return (opts.readResults[filepath] ?? '') as any;
  });
}

function icaclsLine(filepath: string, usersAce: string): string {
  // Mimic the multi-line layout icacls produces:
  //   <path> BUILTIN\Users:<ace>
  //          BUILTIN\Administrators:(I)(F)
  //          NT AUTHORITY\SYSTEM:(I)(F)
  //   Successfully processed 1 files; Failed processing 0 files
  return `${filepath} BUILTIN\\Users:${usersAce}
                                   BUILTIN\\Administrators:(I)(F)
                                   NT AUTHORITY\\SYSTEM:(I)(F)

Successfully processed 1 files; Failed processing 0 files
`;
}

/**
 * Variant for the post-grant case: icacls /grant is additive, so after the
 * self-heal runs once the sibling ends up with TWO Users ACEs on separate
 * lines -- the inherited (I)(RX) one plus the freshly-granted (M) one. The
 * detection regex must match the (M) line even though (I)(RX) appears first.
 */
function icaclsLineMultiUserAce(filepath: string, aces: string[]): string {
  const lines: string[] = [];
  aces.forEach((ace, i) => {
    const prefix = i === 0 ? `${filepath} ` : ' '.repeat(filepath.length + 1);
    lines.push(`${prefix}BUILTIN\\Users:${ace}`);
  });
  lines.push(`${' '.repeat(filepath.length + 1)}BUILTIN\\Administrators:(I)(F)`);
  lines.push(`${' '.repeat(filepath.length + 1)}NT AUTHORITY\\SYSTEM:(I)(F)`);
  lines.push('');
  lines.push('Successfully processed 1 files; Failed processing 0 files');
  return lines.join('\n') + '\n';
}

// --- Tests -------------------------------------------------------------------

describe('ensureSiblingDbAcl — runtime self-heal', () => {
  it('no-ops when neither sibling file exists', () => {
    mockExistsSyncFor([]);
    ds.ensureSiblingDbAcl();
    // Should never invoke icacls if the files don't exist.
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('no-ops when wal/shm already grant Users:(M) explicitly', () => {
    mockExistsSyncFor([FAKE_WAL, FAKE_SHM]);
    mockIcacls({
      readResults: {
        [FAKE_WAL]: icaclsLine(FAKE_WAL, '(M)'),
        [FAKE_SHM]: icaclsLine(FAKE_SHM, '(M)'),
      },
    });
    ds.ensureSiblingDbAcl();
    // Two reads for detection; no /grant calls.
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => !(c[1] as string[]).includes('/grant'))).toBe(true);
  });

  it('no-ops when ACL grants Users:(I)(M) — inherited Modify is sufficient', () => {
    mockExistsSyncFor([FAKE_WAL, FAKE_SHM]);
    mockIcacls({
      readResults: {
        [FAKE_WAL]: icaclsLine(FAKE_WAL, '(I)(M)'),
        [FAKE_SHM]: icaclsLine(FAKE_SHM, '(I)(M)'),
      },
    });
    ds.ensureSiblingDbAcl();
    const grantCalls = vi.mocked(execFileSync).mock.calls.filter((c) =>
      (c[1] as string[]).includes('/grant'),
    );
    expect(grantCalls).toHaveLength(0);
  });

  it('no-ops when ACL grants Users:(F) or Users:(I)(F) — Full covers Modify', () => {
    mockExistsSyncFor([FAKE_WAL, FAKE_SHM]);
    mockIcacls({
      readResults: {
        [FAKE_WAL]: icaclsLine(FAKE_WAL, '(F)'),
        [FAKE_SHM]: icaclsLine(FAKE_SHM, '(I)(F)'),
      },
    });
    ds.ensureSiblingDbAcl();
    const grantCalls = vi.mocked(execFileSync).mock.calls.filter((c) =>
      (c[1] as string[]).includes('/grant'),
    );
    expect(grantCalls).toHaveLength(0);
  });

  it('grants Users:(M) when wal/shm have only inherited (I)(RX) — the bug case', () => {
    mockExistsSyncFor([FAKE_WAL, FAKE_SHM]);
    mockIcacls({
      readResults: {
        [FAKE_WAL]: icaclsLine(FAKE_WAL, '(I)(RX)'),
        [FAKE_SHM]: icaclsLine(FAKE_SHM, '(I)(RX)'),
      },
    });
    ds.ensureSiblingDbAcl();

    const calls = vi.mocked(execFileSync).mock.calls;
    const grantCalls = calls.filter((c) => (c[1] as string[]).includes('/grant'));
    expect(grantCalls).toHaveLength(2);

    // Each grant call: icacls.exe <filepath> /grant *S-1-5-32-545:(M) /Q
    const grantTargets = grantCalls.map((c) => (c[1] as string[])[0]);
    expect(grantTargets.sort()).toEqual([FAKE_SHM, FAKE_WAL].sort());

    const grantArgs = grantCalls[0][1] as string[];
    expect(grantArgs).toContain('/grant');
    expect(grantArgs).toContain('*S-1-5-32-545:(M)');
    expect(grantArgs).toContain('/Q');
  });

  it('still grants when ACL has (RX,W,D) but no M/F token — conservative detection', () => {
    // (RX,W,D) might be functionally writable but our regex requires M or F.
    // This is intentional: SQLite's WAL+SHM lifecycle benefits from full
    // Modify (delete on checkpoint cleanup), and the conservative path costs
    // only one extra additive icacls call. Pin the behavior so a reviewer
    // tightening the regex doesn't accidentally relax it.
    mockExistsSyncFor([FAKE_WAL]);
    mockIcacls({
      readResults: { [FAKE_WAL]: icaclsLine(FAKE_WAL, '(RX,W,D)') },
    });
    ds.ensureSiblingDbAcl();
    const grantCalls = vi.mocked(execFileSync).mock.calls.filter((c) =>
      (c[1] as string[]).includes('/grant'),
    );
    expect(grantCalls).toHaveLength(1);
  });

  it('logs warning and continues when icacls /grant throws (no WRITE_DAC)', () => {
    mockExistsSyncFor([FAKE_WAL, FAKE_SHM]);
    mockIcacls({
      readResults: {
        [FAKE_WAL]: icaclsLine(FAKE_WAL, '(I)(RX)'),
        [FAKE_SHM]: icaclsLine(FAKE_SHM, '(I)(RX)'),
      },
      grantThrows: {
        [FAKE_WAL]: new Error('Access is denied.'),
      },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => ds.ensureSiblingDbAcl()).not.toThrow();

    // wal grant failed -> warning. shm grant succeeded -> info log.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('icacls grant failed on workbench.db-wal'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('granted Users:M on workbench.db-shm'),
    );

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('detects post-grant additive output: two Users ACEs on separate lines', () => {
    // After a successful icacls /grant, the file ends with BOTH the original
    // inherited ACE AND the freshly-granted Modify ACE on adjacent lines.
    // The detection regex scans the full multi-line output and must match
    // the (M) line, returning true so we no-op on subsequent starts. If this
    // case ever broke, repeat starts would re-grant indefinitely.
    mockExistsSyncFor([FAKE_WAL]);
    mockIcacls({
      readResults: {
        [FAKE_WAL]: icaclsLineMultiUserAce(FAKE_WAL, ['(I)(RX)', '(M)']),
      },
    });
    ds.ensureSiblingDbAcl();
    const grantCalls = vi.mocked(execFileSync).mock.calls.filter((c) =>
      (c[1] as string[]).includes('/grant'),
    );
    expect(grantCalls).toHaveLength(0);
  });

  it('handles partial existence — only one of wal/shm exists', () => {
    mockExistsSyncFor([FAKE_WAL]);  // shm absent
    mockIcacls({
      readResults: { [FAKE_WAL]: icaclsLine(FAKE_WAL, '(I)(RX)') },
    });
    ds.ensureSiblingDbAcl();
    const calls = vi.mocked(execFileSync).mock.calls;
    // 1 read for wal + 1 grant for wal. No calls referencing shm.
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => (c[1] as string[])[0] === FAKE_WAL)).toBe(true);
  });

  it('does not trigger grant for (WMC) — M embedded in longer token is not a match', () => {
    // The regex uses \b[MF]\b so M must be a standalone word token.
    // (WMC) contains M but as a non-boundary character; the check should
    // return false and grant should run. This pins the \b guard so a future
    // simplification to bare [MF] does not silently allow (WMC) through.
    mockExistsSyncFor([FAKE_WAL]);
    mockIcacls({
      readResults: { [FAKE_WAL]: icaclsLine(FAKE_WAL, '(WMC)') },
    });
    ds.ensureSiblingDbAcl();
    const grantCalls = vi.mocked(execFileSync).mock.calls.filter((c) =>
      (c[1] as string[]).includes('/grant'),
    );
    expect(grantCalls).toHaveLength(1);
  });

  it('no-ops on non-Windows: short-circuit before any icacls call', () => {
    // On non-win32 ensureSiblingDbAcl() returns immediately; no icacls I/O.
    // Pins the platform guard so removing it would surface in cross-platform CI.
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      mockExistsSyncFor([FAKE_WAL, FAKE_SHM]);
      ds.ensureSiblingDbAcl();
      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});
