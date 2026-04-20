import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StartupPickerModal } from '../../src/renderer/components/dashboard/StartupPickerModal.js';
import type { StartupItemMetric } from '../../src/shared/types.js';

const ITEMS: StartupItemMetric[] = [
  { name: 'Notifiarr', location: 'HKCU\\...\\Run', kind: 'Run', is_essential: true, disabled_in_registry: false, publisher: 'Notifiarr Inc.' },
  { name: 'LGHUB', location: 'HKCU\\...\\Run', kind: 'Run', is_essential: true, disabled_in_registry: false, publisher: 'Logitech' },
  { name: 'Steam', location: 'HKCU\\...\\Run', kind: 'Run', is_essential: false, disabled_in_registry: false, publisher: 'Valve', size_bytes: 12_345_678 },
  { name: 'Discord', location: 'HKCU\\...\\Run', kind: 'Run', is_essential: false, disabled_in_registry: false, publisher: 'Discord Inc.' },
  { name: 'OldTool', location: 'HKLM\\...\\Run', kind: 'HKLM_Run', is_essential: false, disabled_in_registry: true, publisher: 'Vendor X' },
];

describe('<StartupPickerModal> — C1', () => {
  it('filters out items already disabled in the registry', () => {
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} />);
    // OldTool is disabled_in_registry → not shown
    expect(screen.queryByText('OldTool')).toBeNull();
    // Others present — match the name cell via aria-label on the row checkbox
    expect(screen.getByLabelText('Disable Notifiarr')).toBeTruthy();
    expect(screen.getByLabelText('Disable Steam')).toBeTruthy();
  });

  it('preselects non-essential items and excludes essentials', () => {
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} />);
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    // Row order = enabled items in order: Notifiarr (essential), LGHUB (essential), Steam, Discord
    expect(checkboxes.length).toBe(4);
    expect(checkboxes[0].checked).toBe(false); // Notifiarr
    expect(checkboxes[1].checked).toBe(false); // LGHUB
    expect(checkboxes[2].checked).toBe(true);  // Steam
    expect(checkboxes[3].checked).toBe(true);  // Discord
  });

  it('submits only the selected items to onDisable', () => {
    const onDisable = vi.fn();
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={onDisable} />);
    fireEvent.click(screen.getByText(/Disable Selected/));
    expect(onDisable).toHaveBeenCalledWith([
      { kind: 'Run', name: 'Steam' },
      { kind: 'Run', name: 'Discord' },
    ]);
  });

  it('shows the under/over-threshold note based on remaining count', () => {
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} threshold={3} />);
    // 4 enabled - 2 preselected = 2 remaining → under threshold 3
    expect(screen.getByText(/under 3 threshold/)).toBeTruthy();
  });
});
