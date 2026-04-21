import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActionResultModal } from '../../src/renderer/components/dashboard/ActionResultModal.js';
import { ACTIONS } from '../../src/shared/actions.js';

describe('<ActionResultModal> — B1', () => {
  it('renders analyze_minidump breakdown with key fields + output tail', () => {
    const result = {
      bug_check_hex: '0xA',
      faulting_module: 'nvlddmkm.sys',
      probable_cause: 'IRQL_NOT_LESS_OR_EQUAL (NVIDIA driver)',
      dump_path: 'C:\\Windows\\Minidump\\041926-12344-01.dmp',
      // v2.4.6: widened the tail window from 15 to 40 lines so users
      // get real context when the parser's regexes miss (raw cdb output
      // is often what matters most on a failed run). Fixture sized to
      // 50 so we can assert the trimming still happens.
      full_output_tail: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`),
    };
    render(
      <ActionResultModal
        action={ACTIONS.analyze_minidump}
        result={result}
        onClose={() => {}}
      />,
    );
    // Title
    expect(screen.getByText(/Analyze Latest Minidump — Result/)).toBeTruthy();
    // Key fields
    expect(screen.getByText('bug_check_hex')).toBeTruthy();
    expect(screen.getByText('0xA')).toBeTruthy();
    expect(screen.getByText('nvlddmkm.sys')).toBeTruthy();
    expect(screen.getByText(/IRQL_NOT_LESS_OR_EQUAL/)).toBeTruthy();
    // v2.4.6: last 40 lines rendered (lines 11-50 present, line 10 cut).
    const pre = document.querySelector('pre')!;
    expect(pre.textContent).toContain('line 50');
    expect(pre.textContent).toContain('line 11');
    expect(pre.textContent).not.toContain('line 10');
  });

  it('renders SMART result drives + warnings', () => {
    const result = {
      drives: [
        { model: 'Samsung 980', size_gb: 1000, health: 'PASSED', temp_c: 42, wear_pct: 2 },
      ],
      skipped: [{ model: 'USB Reader', reason: 'size < 1GB' }],
      warnings: ['Drive 0 reports pending reallocation'],
    };
    render(
      <ActionResultModal
        action={ACTIONS.run_smart_check}
        result={result}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/SMART Health Check — Result/)).toBeTruthy();
    expect(screen.getByText('Samsung 980')).toBeTruthy();
    expect(screen.getByText(/PASSED/)).toBeTruthy();
    expect(screen.getByText(/USB Reader/)).toBeTruthy();   // skipped model rendered
    expect(screen.getByText(/Drive 0 reports pending reallocation/)).toBeTruthy();
  });

  it('calls onClose when Close is clicked', () => {
    const onClose = vi.fn();
    render(
      <ActionResultModal
        action={ACTIONS.analyze_minidump}
        result={{ bug_check_hex: '0x0' }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});
