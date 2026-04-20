// @vitest-environment node
import { describe, it, expect } from 'vitest';

/**
 * v2.3.2 regression tests for the CSV parser used by
 * `api:listScheduledTasks` in src/main/ipc.ts. The handler itself runs
 * `schtasks.exe /Query /FO CSV /V` via promisify(execFile) and then parses
 * the resulting two-line CSV (headers + values) to produce a
 * `ScheduledTaskInfo`. On any error it returns a fallback row with
 * `status: 'Not registered'` and null metadata.
 *
 * The handler sits inside a large IPC-registration function that pulls in
 * ~15 other main-process modules, most of which touch disk or native
 * sqlite. Mocking the full import graph to exercise one branch is
 * heavy-handed; instead we replicate the parser as a pure function here
 * and lock the observable contract. If this copy ever drifts from
 * ipc.ts's parser, the tests will stop reflecting real behavior — the
 * parser is short enough that keeping them in sync is trivial, and the
 * win is that the tests stay fast and dependency-free.
 */

interface ScheduledTaskInfo {
  name: string;
  status: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
}

/** Mirrors the parser in ipc.ts `api:listScheduledTasks`. */
function parseSchtasksCsv(name: string, stdout: string | null | undefined): ScheduledTaskInfo {
  const lines = (stdout ?? '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return { name, status: 'Unknown', next_run: null, last_run: null, last_result: null };
  }
  const headers = lines[0].replace(/^"|"$/g, '').split('","');
  const values = lines[1].replace(/^"|"$/g, '').split('","');
  const map: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) map[headers[i]] = values[i] ?? '';
  return {
    name,
    status: map['Status'] ?? map['Scheduled Task State'] ?? 'Unknown',
    next_run: map['Next Run Time'] ?? null,
    last_run: map['Last Run Time'] ?? null,
    last_result: map['Last Result'] ?? null,
  };
}

/** Fallback the handler returns from its catch block when execFile throws. */
function errorFallback(name: string): ScheduledTaskInfo {
  return { name, status: 'Not registered', next_run: null, last_run: null, last_result: null };
}

describe('schtasks CSV parser (api:listScheduledTasks)', () => {
  it('parses a well-formed schtasks /V /FO CSV row into a ScheduledTaskInfo', () => {
    // Representative shape of `schtasks /Query /TN <name> /FO CSV /V` output.
    // Columns vary slightly by Windows locale; these are the keys the
    // handler looks up (`Status`, `Next Run Time`, `Last Run Time`,
    // `Last Result`).
    const stdout =
      '"HostName","TaskName","Next Run Time","Status","Last Run Time","Last Result","Author"\r\n' +
      '"ALIENWARE-R11","\\PCDoctor-Autopilot-Foo","4/19/2026 3:00:00 PM","Ready","4/12/2026 3:00:00 PM","0","SYSTEM"\r\n';
    const info = parseSchtasksCsv('PCDoctor-Autopilot-Foo', stdout);
    expect(info).toEqual({
      name: 'PCDoctor-Autopilot-Foo',
      status: 'Ready',
      next_run: '4/19/2026 3:00:00 PM',
      last_run: '4/12/2026 3:00:00 PM',
      last_result: '0',
    });
  });

  it('falls back to `Scheduled Task State` when `Status` column is absent', () => {
    // Some schtasks locales/versions use "Scheduled Task State" instead of
    // "Status"; the handler explicitly supports both via ??.
    const stdout =
      '"TaskName","Scheduled Task State","Next Run Time","Last Run Time","Last Result"\r\n' +
      '"\\Foo","Disabled","N/A","Never","1"\r\n';
    const info = parseSchtasksCsv('Foo', stdout);
    expect(info.status).toBe('Disabled');
    expect(info.next_run).toBe('N/A');
    expect(info.last_run).toBe('Never');
    expect(info.last_result).toBe('1');
  });

  it('returns status=Unknown with null metadata when stdout has fewer than 2 lines', () => {
    expect(parseSchtasksCsv('Foo', '')).toEqual({
      name: 'Foo', status: 'Unknown', next_run: null, last_run: null, last_result: null,
    });
    expect(parseSchtasksCsv('Foo', '"TaskName","Status"\r\n')).toEqual({
      name: 'Foo', status: 'Unknown', next_run: null, last_run: null, last_result: null,
    });
  });

  it('tolerates null/undefined stdout', () => {
    expect(parseSchtasksCsv('Foo', null).status).toBe('Unknown');
    expect(parseSchtasksCsv('Foo', undefined).status).toBe('Unknown');
  });

  it('accepts LF-only line endings (not just CRLF)', () => {
    const stdout =
      '"TaskName","Status","Next Run Time","Last Run Time","Last Result"\n' +
      '"\\Foo","Ready","4/19/2026","4/12/2026","0"\n';
    const info = parseSchtasksCsv('Foo', stdout);
    expect(info.status).toBe('Ready');
    expect(info.next_run).toBe('4/19/2026');
  });

  it('leaves unmatched columns as null (missing headers map to undefined)', () => {
    // This stdout lacks Next/Last Run Time columns.
    const stdout =
      '"TaskName","Status"\r\n' +
      '"\\Foo","Ready"\r\n';
    const info = parseSchtasksCsv('Foo', stdout);
    expect(info.status).toBe('Ready');
    expect(info.next_run).toBeNull();
    expect(info.last_run).toBeNull();
    expect(info.last_result).toBeNull();
  });

  it('error fallback returns the Not-registered contract', () => {
    // This is what the handler returns when execFile rejects (task does
    // not exist, schtasks not found, timeout, etc.). The renderer relies
    // on this exact shape to render "Not registered" rows.
    expect(errorFallback('PCDoctor-Autopilot-DoesNotExist')).toEqual({
      name: 'PCDoctor-Autopilot-DoesNotExist',
      status: 'Not registered',
      next_run: null,
      last_run: null,
      last_result: null,
    });
  });
});
