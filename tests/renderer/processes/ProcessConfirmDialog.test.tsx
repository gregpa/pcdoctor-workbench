/**
 * v2.5.30 (P4): tests for ProcessConfirmDialog.
 *
 * Mirrors ServiceConfirmDialog tests but for processes. Locks:
 *   - open=false renders nothing
 *   - regular kill: Confirm enabled, button label is "Kill"
 *   - regular suspend: Confirm enabled, button label is "Suspend"
 *   - system_critical: gate disables Confirm until "I understand" ticked
 *   - reopen resets the gate
 *   - Cancel / Confirm dispatch correctly
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProcessConfirmDialog } from '@renderer/components/processes/ProcessConfirmDialog.js';

const PROC_REGULAR  = { pid: 1234, name: 'chrome' };
const PROC_CRITICAL = { pid: 1596, name: 'csrss' };

describe('ProcessConfirmDialog', () => {
  it('open=false renders nothing', () => {
    const { container } = render(
      <ProcessConfirmDialog
        open={false}
        process={PROC_REGULAR}
        kind="kill"
        systemCritical={false}
        systemCriticalReason={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('regular kill: Confirm enabled, button reads "Kill"', () => {
    render(
      <ProcessConfirmDialog
        open={true}
        process={PROC_REGULAR}
        kind="kill"
        systemCritical={false}
        systemCriticalReason={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const confirm = screen.getByRole('button', { name: /^kill$/i });
    expect(confirm).toBeEnabled();
    expect(screen.queryByText(/system process/i)).not.toBeInTheDocument();
    cleanup();
  });

  it('regular suspend: button reads "Suspend"', () => {
    render(
      <ProcessConfirmDialog
        open={true}
        process={PROC_REGULAR}
        kind="suspend"
        systemCritical={false}
        systemCriticalReason={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^suspend$/i })).toBeInTheDocument();
    cleanup();
  });

  it('system_critical kill: Confirm disabled until "I understand" ticked', () => {
    render(
      <ProcessConfirmDialog
        open={true}
        process={PROC_CRITICAL}
        kind="kill"
        systemCritical={true}
        systemCriticalReason="csrss kill bluescreens the system"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const confirm = screen.getByRole('button', { name: /^kill$/i });
    expect(confirm).toBeDisabled();
    // Banner text appears (banner heading + checkbox label both contain
    // "system process" so use getAllByText).
    expect(screen.getAllByText(/system process/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/bluescreens/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /i understand the risk/i }));
    expect(confirm).toBeEnabled();
    cleanup();
  });

  it('reopening resets the gate', () => {
    const { rerender } = render(
      <ProcessConfirmDialog
        open={true}
        process={PROC_CRITICAL}
        kind="kill"
        systemCritical={true}
        systemCriticalReason="x"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /i understand/i }));
    expect(screen.getByRole('button', { name: /^kill$/i })).toBeEnabled();

    rerender(
      <ProcessConfirmDialog
        open={false}
        process={PROC_CRITICAL}
        kind="kill"
        systemCritical={true}
        systemCriticalReason="x"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    rerender(
      <ProcessConfirmDialog
        open={true}
        process={PROC_CRITICAL}
        kind="kill"
        systemCritical={true}
        systemCriticalReason="x"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^kill$/i })).toBeDisabled();
    cleanup();
  });

  it('Cancel + Confirm fire the right callback', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ProcessConfirmDialog
        open={true}
        process={PROC_REGULAR}
        kind="kill"
        systemCritical={false}
        systemCriticalReason={null}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^kill$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
