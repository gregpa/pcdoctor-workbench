/**
 * v2.5.18: Shared state for the 10-step first-run wizard.
 *
 * Uses React context + useReducer so every step component can read/write
 * wizard state without prop-drilling. The provider lives in WizardShell;
 * step components consume via useWizard().
 */

import { createContext, useContext, useReducer, useMemo, type ReactNode } from 'react';
import type { SystemProfile } from '@shared/types.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface WizardState {
  currentStep: number;            // 0-8 (W1=0 through W10=8 after v2.5.25 W6 removal)
  completedSteps: Set<number>;

  // W2 — System profile (Get-SystemProfile.ps1 output)
  systemProfile: SystemProfile | null;

  // W3 — NAS config
  nasServer: string;
  nasMappings: Array<{ drive: string; share: string }>;

  // W4 — Security prefs
  defenderExclusionApplied: boolean;

  // W5 — Notification prefs
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  quietHoursStart: number;
  quietHoursEnd: number;

  // (v2.5.25: W6 selectedTools field removed -- the wizard never installed
  //  the tools the user picked. Tools are installed from the Tools page.)

  // W7 — Autopilot
  autopilotEnabled: boolean;

  // W8 — Integrations
  claudeDetected: boolean;
  obsidianEnabled: boolean;
  obsidianArchiveDir: string;
  wslMemoryLimitGb: number | null;

  // W9 — Scheduled tasks
  tasksRegistered: boolean;

  // Completion
  initialScanTriggered: boolean;
}

const INITIAL_STATE: WizardState = {
  currentStep: 0,
  completedSteps: new Set(),
  systemProfile: null,
  nasServer: '',
  nasMappings: [],
  defenderExclusionApplied: false,
  telegramEnabled: false,
  telegramBotToken: '',
  telegramChatId: '',
  quietHoursStart: 22,
  quietHoursEnd: 7,
  autopilotEnabled: true,
  claudeDetected: false,
  obsidianEnabled: false,
  obsidianArchiveDir: '',
  wslMemoryLimitGb: null,
  tasksRegistered: false,
  initialScanTriggered: false,
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type WizardAction =
  | { type: 'SET_SYSTEM_PROFILE'; payload: SystemProfile }
  | { type: 'SET_NAS_CONFIG'; payload: { nasServer: string; nasMappings: Array<{ drive: string; share: string }> } }
  | { type: 'SET_FIELD'; field: keyof WizardState; value: WizardState[keyof WizardState] }
  | { type: 'MARK_STEP_COMPLETED'; step: number }
  | { type: 'GO_TO_STEP'; step: number }
  | { type: 'NEXT_STEP' }
  | { type: 'PREV_STEP' };

const TOTAL_STEPS = 9;  // v2.5.25: 10 -> 9 after W6 (Tools) removal

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'SET_SYSTEM_PROFILE':
      return { ...state, systemProfile: action.payload };

    case 'SET_NAS_CONFIG':
      return {
        ...state,
        nasServer: action.payload.nasServer,
        nasMappings: action.payload.nasMappings,
      };

    case 'SET_FIELD':
      return { ...state, [action.field]: action.value };

    case 'MARK_STEP_COMPLETED': {
      const next = new Set(state.completedSteps);
      next.add(action.step);
      return { ...state, completedSteps: next };
    }

    case 'GO_TO_STEP':
      return { ...state, currentStep: Math.max(0, Math.min(TOTAL_STEPS - 1, action.step)) };

    case 'NEXT_STEP':
      return { ...state, currentStep: Math.min(TOTAL_STEPS - 1, state.currentStep + 1) };

    case 'PREV_STEP':
      return { ...state, currentStep: Math.max(0, state.currentStep - 1) };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface WizardContextValue {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  /** Advance to the next step. */
  next: () => void;
  /** Go back one step. */
  back: () => void;
  /** Jump to an arbitrary step (0-based). */
  goTo: (step: number) => void;
  /** Mark a step as completed. */
  markComplete: (step: number) => void;
}

const WizardCtx = createContext<WizardContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function WizardProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_STATE);

  const value = useMemo<WizardContextValue>(() => ({
    state,
    dispatch,
    next: () => dispatch({ type: 'NEXT_STEP' }),
    back: () => dispatch({ type: 'PREV_STEP' }),
    goTo: (step: number) => dispatch({ type: 'GO_TO_STEP', step }),
    markComplete: (step: number) => dispatch({ type: 'MARK_STEP_COMPLETED', step }),
  }), [state, dispatch]);

  return <WizardCtx.Provider value={value}>{children}</WizardCtx.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWizard(): WizardContextValue {
  const ctx = useContext(WizardCtx);
  if (!ctx) throw new Error('useWizard() must be used inside <WizardProvider>');
  return ctx;
}
