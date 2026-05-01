/**
 * W9 Scheduled Tasks -- ninth step of the first-run wizard (index 8).
 *
 * Checks which Windows Task Scheduler entries are already registered,
 * displays a count, and offers a one-click "Register All Tasks" button
 * that invokes Register-All-Tasks.ps1 via UAC elevation.
 *
 * On unmount: markComplete(8).
 */

import { useEffect, useState, useCallback } from 'react';
import { useWizard } from '../WizardContext.js';
import type { ScheduledTaskInfo } from '@shared/types.js';

export function W9ScheduledTasks() {
  const { dispatch, markComplete } = useWizard();

  // Fetch state
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<ScheduledTaskInfo[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Register action state
  const [registerBusy, setRegisterBusy] = useState(false);
  const [registerSuccess, setRegisterSuccess] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  // Fetch task list on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.api.listScheduledTasks();
        if (cancelled) return;
        if (result.ok) {
          setTasks(result.data);
        } else {
          setFetchError(result.error?.message ?? 'Unknown error fetching scheduled tasks.');
        }
      } catch (e) {
        if (!cancelled) {
          setFetchError(e instanceof Error ? e.message : 'Failed to fetch scheduled tasks.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Register all tasks
  const handleRegister = useCallback(async () => {
    setRegisterBusy(true);
    setRegisterError(null);
    try {
      const r = await window.api.runAction({ name: 'register_scheduled_tasks' });
      if (r.ok && r.data.success) {
        setRegisterSuccess(true);
        dispatch({ type: 'SET_FIELD', field: 'tasksRegistered', value: true });
        // Re-fetch to update count
        try {
          const refreshed = await window.api.listScheduledTasks();
          if (refreshed.ok) setTasks(refreshed.data);
        } catch { /* non-fatal */ }
      } else {
        const msg = r.ok
          ? r.data.error?.message ?? 'Registration failed'
          : r.error?.message ?? 'IPC error';
        setRegisterError(msg);
      }
    } catch (e) {
      setRegisterError(e instanceof Error ? e.message : 'Unexpected error');
    } finally {
      setRegisterBusy(false);
    }
  }, [dispatch]);

  // Mark complete on unmount
  useEffect(() => {
    return () => { markComplete(8); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Loading --
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <div className="w-8 h-8 border-2 border-status-info border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-text-secondary">Checking scheduled tasks&hellip;</p>
      </div>
    );
  }

  const taskCount = tasks.length;

  return (
    <div className="flex flex-col gap-5 py-2">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold text-text-primary">Scheduled Tasks</h2>
        <p className="text-sm text-text-secondary mt-0.5">
          Register automated maintenance tasks with Windows Task Scheduler.
        </p>
      </div>

      {/* Info card */}
      <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
        <p className="text-sm text-text-secondary">
          These tasks keep your PC maintained automatically. They run PowerShell
          scripts on schedule to perform diagnostics, cleanup, and monitoring.
        </p>
      </div>

      {/* Current status */}
      {fetchError ? (
        <div className="rounded-lg border border-status-warn/30 bg-status-warn/10 px-4 py-3">
          <p className="text-sm text-status-warn">
            Could not check existing tasks.
          </p>
          <p className="text-xs text-text-secondary mt-1">{fetchError}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
          <p className="text-sm text-text-primary">
            {taskCount > 0
              ? `${taskCount} task${taskCount !== 1 ? 's' : ''} already registered`
              : 'No tasks registered yet'}
          </p>
        </div>
      )}

      {/* Register button */}
      <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary">Register All Tasks</h3>
        <p className="text-xs text-text-secondary mt-1">
          This will register all PCDoctor scheduled tasks. Requires administrator
          elevation (UAC prompt).
        </p>

        {registerSuccess ? (
          <p className="text-sm text-status-good mt-3">Tasks registered successfully.</p>
        ) : (
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={handleRegister}
              disabled={registerBusy}
              className="px-4 py-1.5 rounded-md bg-status-info text-white text-sm font-semibold hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {registerBusy ? 'Registering…' : 'Register All Tasks'}
            </button>
            <span className="text-xs text-text-secondary">or skip by clicking Next</span>
          </div>
        )}

        {registerError && (
          <div className="mt-2">
            <p className="text-xs text-status-warn">{registerError}</p>
            <p className="text-xs text-text-secondary mt-1">
              You can register tasks later from Settings &gt; Scheduled Tasks.
            </p>
          </div>
        )}
      </div>

      {/* Bottom note */}
      <p className="text-xs text-text-secondary">
        You can review and modify these in Settings &gt; Scheduled Tasks.
      </p>
    </div>
  );
}
