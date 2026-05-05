/**
 * v2.5.30: tests for ServiceConfirmDialog.
 *
 * Behaviors locked:
 *   - open=false -> renders nothing
 *   - regular service: Confirm button is enabled out of the box
 *   - load-bearing service: Confirm disabled until "I understand" checked
 *   - "I understand" checkbox is reset between dialog re-opens
 *   - Cancel fires onCancel, never onConfirm
 *   - Confirm fires onConfirm
 *   - preview=null shows "Computing preview..." placeholder
 *   - preview given shows before/after blocks (status + start_type)
 *   - runningDependents banner appears when present
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ServiceConfirmDialog, type ServicePreview } from '@renderer/components/services/ServiceConfirmDialog.js';

const SVC_REGULAR = { key: 'Spooler', display: 'Print Spooler' };
const SVC_LOAD_BEARING = { key: 'RpcSs', display: 'Remote Procedure Call (RPC)' };

const PREVIEW: ServicePreview = {
  before: { status: 'Running', start_type: 'Automatic' },
  after:  { status: 'Running', start_type: 'Disabled' },
};

describe('ServiceConfirmDialog', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <ServiceConfirmDialog
        open={false}
        service={SVC_REGULAR}
        kind="set-startup"
        startupTypeTarget="Disabled"
        preview={PREVIEW}
        loadBearing={false}
        loadBearingReason={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('regular service: Confirm enabled, load-bearing banner absent', () => {
    render(
      <ServiceConfirmDialog
        open={true}
        service={SVC_REGULAR}
        kind="set-startup"
        startupTypeTarget="Disabled"
        preview={PREVIEW}
        loadBearing={false}
        loadBearingReason={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const confirm = screen.getByRole('button', { name: /confirm/i });
    expect(confirm).toBeEnabled();
    expect(screen.queryByText(/system service/i)).not.toBeInTheDocument();
    cleanup();
  });

  it('load-bearing: Confirm disabled until checkbox ticked', () => {
    render(
      <ServiceConfirmDialog
        open={true}
        service={SVC_LOAD_BEARING}
        kind="set-startup"
        startupTypeTarget="Disabled"
        preview={PREVIEW}
        loadBearing={true}
        loadBearingReason="RPC: disabling halts every other service."
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const confirm = screen.getByRole('button', { name: /confirm/i });
    expect(confirm).toBeDisabled();
    // Banner content visible. The exact phrase "This is a system service."
    // appears both in the banner heading AND in the checkbox label, so
    // use getAllByText and assert >= 1.
    expect(screen.getAllByText(/this is a system service/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/halts every other service/i)).toBeInTheDocument();
    // Tick the checkbox.
    const checkbox = screen.getByRole('checkbox', { name: /i understand the risk/i });
    fireEvent.click(checkbox);
    expect(confirm).toBeEnabled();
    cleanup();
  });

  it('reopening on a different service resets "I understand"', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ServiceConfirmDialog
        open={true}
        service={SVC_LOAD_BEARING}
        kind="set-startup"
        startupTypeTarget="Disabled"
        preview={PREVIEW}
        loadBearing={true}
        loadBearingReason="x"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /i understand/i }));
    expect(screen.getByRole('button', { name: /confirm/i })).toBeEnabled();

    // Close dialog (open=false), then reopen with a fresh load-bearing service.
    rerender(
      <ServiceConfirmDialog
        open={false}
        service={SVC_LOAD_BEARING}
        kind="set-startup"
        startupTypeTarget="Disabled"
        preview={PREVIEW}
        loadBearing={true}
        loadBearingReason="x"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    rerender(
      <ServiceConfirmDialog
        open={true}
        service={SVC_LOAD_BEARING}
        kind="set-startup"
        startupTypeTarget="Disabled"
        preview={PREVIEW}
        loadBearing={true}
        loadBearingReason="x"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
    cleanup();
  });

  it('Cancel fires onCancel and not onConfirm', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ServiceConfirmDialog
        open={true}
        service={SVC_REGULAR}
        kind="stop"
        preview={PREVIEW}
        loadBearing={false}
        loadBearingReason={null}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    cleanup();
  });

  it('Confirm fires onConfirm', () => {
    const onConfirm = vi.fn();
    render(
      <ServiceConfirmDialog
        open={true}
        service={SVC_REGULAR}
        kind="start"
        preview={PREVIEW}
        loadBearing={false}
        loadBearingReason={null}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('preview=null shows "Computing preview..." placeholder', () => {
    render(
      <ServiceConfirmDialog
        open={true}
        service={SVC_REGULAR}
        kind="set-startup"
        startupTypeTarget="Manual"
        preview={null}
        loadBearing={false}
        loadBearingReason={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/computing preview/i)).toBeInTheDocument();
    cleanup();
  });

  it('preview given: before/after status + start_type rendered', () => {
    render(
      <ServiceConfirmDialog
        open={true}
        service={SVC_REGULAR}
        kind="set-startup"
        startupTypeTarget="Disabled"
        preview={PREVIEW}
        loadBearing={false}
        loadBearingReason={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    // Two "Running" cells (before + after).
    const runs = screen.getAllByText(/running/i);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Startup: Automatic/)).toBeInTheDocument();
    expect(screen.getByText(/Startup: Disabled/)).toBeInTheDocument();
    cleanup();
  });

  it('runningDependents banner appears when populated', () => {
    render(
      <ServiceConfirmDialog
        open={true}
        service={SVC_REGULAR}
        kind="stop"
        preview={{ before: { status: 'Running' }, after: { status: 'Stopped' } }}
        loadBearing={false}
        loadBearingReason={null}
        runningDependents={['Fax', 'PrintNotify']}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/Will also stop 2 running dependents/i)).toBeInTheDocument();
    expect(screen.getByText(/Fax, PrintNotify/)).toBeInTheDocument();
    cleanup();
  });
});
