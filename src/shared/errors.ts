export const ERROR_CODES = {
  // PowerShell script
  PS_NONZERO_EXIT: 'E_PS_NONZERO_EXIT',
  PS_INVALID_JSON: 'E_PS_INVALID_JSON',
  PS_UNHANDLED: 'E_PS_UNHANDLED',
  PS_TIMEOUT: 'E_TIMEOUT_KILLED',

  // Bridge
  BRIDGE_READ_FAILED: 'E_BRIDGE_READ_FAILED',
  BRIDGE_PARSE_FAILED: 'E_BRIDGE_PARSE_FAILED',
  BRIDGE_FILE_MISSING: 'E_BRIDGE_FILE_MISSING',

  // Action
  ACTION_UNKNOWN: 'E_ACTION_UNKNOWN',
  ACTION_FAILED: 'E_ACTION_FAILED',

  // Generic
  INTERNAL: 'E_INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Friendly messages shown in the UI. Keep short and actionable. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  E_PS_NONZERO_EXIT: 'A PowerShell script exited with an error.',
  E_PS_INVALID_JSON: 'The PowerShell script returned unexpected output.',
  E_PS_UNHANDLED: 'The PowerShell script hit an unhandled error.',
  E_TIMEOUT_KILLED: 'The operation timed out and was terminated.',
  E_BRIDGE_READ_FAILED: 'Could not read the diagnostic report from disk.',
  E_BRIDGE_PARSE_FAILED: 'The diagnostic report was corrupted.',
  E_BRIDGE_FILE_MISSING: 'No diagnostic report found. Run a PC scan first.',
  E_ACTION_UNKNOWN: 'Unknown action.',
  E_ACTION_FAILED: 'Action failed.',
  E_INTERNAL: 'An internal error occurred.',
};
