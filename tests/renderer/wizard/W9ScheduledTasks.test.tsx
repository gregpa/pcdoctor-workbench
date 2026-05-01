import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WizardProvider } from '../../../src/renderer/components/wizard/WizardContext.js';
import { W9ScheduledTasks } from '../../../src/renderer/components/wizard/steps/W9ScheduledTasks.js';

// ---------------------------------------------------------------------------
// Mock window.api
// ---------------------------------------------------------------------------

const mockApi = {
  listScheduledTasks: vi.fn(),
  runAction: vi.fn(),
  setSetting: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  getSettings: vi.fn().mockResolvedValue({ ok: true, data: {} }),
};

Object.defineProperty(window, 'api', { value: mockApi, writable: true });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockTasks = [
  { name: 'PCDoctor-Scanner', status: 'Ready', next_run: '2026-05-02 08:00', last_run: null, last_result: null },
  { name: 'PCDoctor-Cleanup', status: 'Ready', next_run: '2026-05-03 03:00', last_run: null, last_result: null },
];

function renderW9() {
  return render(
    <WizardProvider>
      <W9ScheduledTasks />
    </WizardProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<W9ScheduledTasks>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while fetching tasks', () => {
    mockApi.listScheduledTasks.mockReturnValue(new Promise(() => {}));
    renderW9();
    expect(screen.getByText(/Checking scheduled tasks/)).toBeInTheDocument();
  });

  it('shows task count when tasks exist', async () => {
    mockApi.listScheduledTasks.mockResolvedValue({ ok: true, data: mockTasks });
    renderW9();
    await waitFor(() => {
      expect(screen.getByText('2 tasks already registered')).toBeInTheDocument();
    });
  });

  it('shows "No tasks registered yet" when list is empty', async () => {
    mockApi.listScheduledTasks.mockResolvedValue({ ok: true, data: [] });
    renderW9();
    await waitFor(() => {
      expect(screen.getByText('No tasks registered yet')).toBeInTheDocument();
    });
  });

  it('shows Register button after loading', async () => {
    mockApi.listScheduledTasks.mockResolvedValue({ ok: true, data: [] });
    renderW9();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Register All Tasks/ })).toBeInTheDocument();
    });
  });

  it('shows success message after successful registration', async () => {
    mockApi.listScheduledTasks.mockResolvedValue({ ok: true, data: [] });
    mockApi.runAction.mockResolvedValue({
      ok: true,
      data: { action: 'register_scheduled_tasks', success: true, duration_ms: 3000 },
    });
    // After registration, re-fetch returns tasks
    mockApi.listScheduledTasks
      .mockResolvedValueOnce({ ok: true, data: [] })        // initial
      .mockResolvedValueOnce({ ok: true, data: mockTasks }); // post-register refresh

    renderW9();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Register All Tasks/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Register All Tasks/ }));

    await waitFor(() => {
      expect(mockApi.runAction).toHaveBeenCalledWith({ name: 'register_scheduled_tasks' });
      expect(screen.getByText('Tasks registered successfully.')).toBeInTheDocument();
    });
  });

  it('shows error message on registration failure', async () => {
    mockApi.listScheduledTasks.mockResolvedValue({ ok: true, data: [] });
    mockApi.runAction.mockResolvedValue({
      ok: true,
      data: {
        action: 'register_scheduled_tasks',
        success: false,
        duration_ms: 100,
        error: { code: 'E_UAC', message: 'UAC prompt was declined' },
      },
    });
    renderW9();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Register All Tasks/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Register All Tasks/ }));

    await waitFor(() => {
      expect(screen.getByText('UAC prompt was declined')).toBeInTheDocument();
      expect(screen.getByText(/You can register tasks later/)).toBeInTheDocument();
    });
  });

  it('shows error when fetch fails', async () => {
    mockApi.listScheduledTasks.mockResolvedValue({
      ok: false,
      error: { code: 'E_SCRIPT', message: 'Task Scheduler not available' },
    });
    renderW9();
    await waitFor(() => {
      expect(screen.getByText(/Could not check existing tasks/)).toBeInTheDocument();
      expect(screen.getByText('Task Scheduler not available')).toBeInTheDocument();
    });
  });

  it('shows error when fetch throws', async () => {
    mockApi.listScheduledTasks.mockRejectedValue(new Error('IPC timeout'));
    renderW9();
    await waitFor(() => {
      expect(screen.getByText(/Could not check existing tasks/)).toBeInTheDocument();
      expect(screen.getByText('IPC timeout')).toBeInTheDocument();
    });
  });

  it('shows busy state while registering', async () => {
    mockApi.listScheduledTasks.mockResolvedValue({ ok: true, data: [] });
    // Never-resolving promise to keep busy state
    mockApi.runAction.mockReturnValue(new Promise(() => {}));
    renderW9();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Register All Tasks/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Register All Tasks/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Registering/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Registering/ })).toBeDisabled();
    });
  });
});
