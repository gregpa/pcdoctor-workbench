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
  UNKNOWN_PARAM: 'E_UNKNOWN_PARAM',
  INVALID_PARAM: 'E_INVALID_PARAM',
  INVALID_PARAM_NAME: 'E_INVALID_PARAM_NAME',
  MISSING_PARAM: 'E_MISSING_PARAM',
  NEEDS_ADMIN: 'E_NEEDS_ADMIN',
  UAC_CANCELLED: 'E_UAC_CANCELLED',
  UAC_DISABLED: 'E_UAC_DISABLED',
  TAMPER_PROTECTION: 'E_TAMPER_PROTECTION',
  ELEVATION_FAILED: 'E_ELEVATION_FAILED',
  ELEVATED_TEMP_EXISTS: 'E_ELEVATED_TEMP_EXISTS',

  // Scheduled tasks / IPC
  SCHTASKS: 'E_SCHTASKS',
  FORBIDDEN: 'E_FORBIDDEN',
  NOT_FOUND: 'E_NOT_FOUND',
  INVALID: 'E_INVALID',

  // Claude bridge
  CLAUDE_LAUNCH: 'E_CLAUDE_LAUNCH',

  // Telegram
  TG_SEND: 'E_TG_SEND',
  TG_TEST: 'E_TG_TEST',
  NO_TOKEN: 'E_NO_TOKEN',

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
  E_UNKNOWN_PARAM: 'Unknown parameter for this action.',
  E_INVALID_PARAM: 'Invalid parameter value.',
  E_INVALID_PARAM_NAME: 'Invalid parameter name.',
  E_MISSING_PARAM: 'Missing required parameter.',
  E_NEEDS_ADMIN: 'This action requires administrator privileges.',
  E_UAC_CANCELLED: 'UAC prompt was cancelled.',
  E_UAC_DISABLED: 'UAC is disabled; admin-only actions cannot elevate.',
  E_TAMPER_PROTECTION: 'Windows Tamper Protection blocks this change. Use Windows Security UI instead.',
  E_ELEVATION_FAILED: 'Could not elevate to administrator.',
  E_ELEVATED_TEMP_EXISTS: 'Temp file collision during elevated action.',
  E_SCHTASKS: 'Scheduled task operation failed.',
  E_FORBIDDEN: 'Operation not permitted.',
  E_NOT_FOUND: 'Not found.',
  E_INVALID: 'Invalid input.',
  E_CLAUDE_LAUNCH: 'Claude Code launch failed.',
  E_TG_SEND: 'Telegram send failed.',
  E_TG_TEST: 'Telegram test failed.',
  E_NO_TOKEN: 'No Telegram token stored.',
  E_INTERNAL: 'An internal error occurred.',
};
