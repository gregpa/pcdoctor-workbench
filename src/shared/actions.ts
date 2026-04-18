import type { ActionName, ActionCategory } from './types.js';

export type ConfirmLevel = 'none' | 'risky' | 'destructive';
export type RollbackTier = 'A' | 'B' | 'C' | 'none';

export interface ActionDefinition {
  name: ActionName;
  label: string;
  ps_script: string;              // path relative to C:\ProgramData\PCDoctor\
  confirm_level: ConfirmLevel;
  rollback_tier: RollbackTier;
  snapshot_paths?: string[];      // for Tier B: file-level snapshot
  restore_point_description?: string; // for Tier A
  estimated_duration_s: number;
  reboot_required?: boolean;
  category: ActionCategory;
  icon: string;                   // emoji for tile
  tooltip: string;                // hover explanation
  params_schema?: Record<string, { type: 'string' | 'number'; required: boolean; description: string }>;
}

export const ACTIONS: Record<ActionName, ActionDefinition> = {
  // ============== CLEANUP ==============
  flush_dns: {
    name: 'flush_dns', label: 'Flush DNS', ps_script: 'actions/Flush-DNS.ps1',
    confirm_level: 'none', rollback_tier: 'C', estimated_duration_s: 2,
    category: 'network', icon: '🔄',
    tooltip: 'Clears the Windows DNS resolver cache (ipconfig /flushdns). Fixes stale domain lookups after VPN changes or DNS outages. Instant.',
  },
  clear_temp_files: {
    name: 'clear_temp_files', label: 'Clear Temp Files', ps_script: 'actions/Clear-TempFiles.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 30,
    category: 'cleanup', icon: '🧹',
    tooltip: 'Deletes contents of %TEMP%, %LOCALAPPDATA%\\Temp, C:\\Windows\\Temp, and all user profile temp folders. Typically reclaims 500MB-2GB. Irreversible.',
  },
  clean_recycle_bin: {
    name: 'clean_recycle_bin', label: 'Empty Recycle Bin', ps_script: 'actions/Clean-RecycleBin.ps1',
    confirm_level: 'destructive', rollback_tier: 'C', estimated_duration_s: 5,
    category: 'cleanup', icon: '🗑',
    tooltip: 'Permanently deletes all items in the Recycle Bin across every drive. Cannot be undone.',
  },
  clean_browser_cache: {
    name: 'clean_browser_cache', label: 'Clean Browser Cache', ps_script: 'actions/Clean-BrowserCache.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 15,
    category: 'cleanup', icon: '🌐',
    tooltip: 'Clears cache from Chrome, Edge, Firefox, Brave. Keeps passwords/cookies. Will sign you out of some sites temporarily.',
  },
  cleanup_winsxs: {
    name: 'cleanup_winsxs', label: 'Cleanup WinSxS', ps_script: 'actions/Cleanup-WinSxS.ps1',
    confirm_level: 'destructive', rollback_tier: 'A',
    restore_point_description: 'PCDoctor: Cleanup WinSxS',
    estimated_duration_s: 600,
    category: 'repair', icon: '📦',
    tooltip: 'Runs DISM /StartComponentCleanup /ResetBase. Removes superseded Windows updates. Typically reclaims 5-15 GB. Irreversible after completion.',
  },
  clean_onedrive_cache: {
    name: 'clean_onedrive_cache', label: 'Clean OneDrive Cache', ps_script: 'actions/Clean-OneDrive-Cache.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 10,
    category: 'cleanup', icon: '☁',
    tooltip: 'Clears OneDrive local cache (not your files). Forces re-sync of recently-changed files.',
  },
  clean_teams_cache: {
    name: 'clean_teams_cache', label: 'Clean Teams Cache', ps_script: 'actions/Clean-Teams-Cache.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 10,
    category: 'cleanup', icon: '👥',
    tooltip: 'Clears Microsoft Teams cache. Fixes Teams startup and login issues. Requires Teams restart.',
  },
  clean_discord_cache: {
    name: 'clean_discord_cache', label: 'Clean Discord Cache', ps_script: 'actions/Clean-Discord-Cache.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 10,
    category: 'cleanup', icon: '💬',
    tooltip: 'Clears Discord cache. Fixes audio/voice issues and reduces RAM footprint.',
  },
  clean_spotify_cache: {
    name: 'clean_spotify_cache', label: 'Clean Spotify Cache', ps_script: 'actions/Clean-Spotify-Cache.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 10,
    category: 'cleanup', icon: '🎵',
    tooltip: 'Clears Spotify cache (not saved music). Typically reclaims 1-10 GB.',
  },

  // ============== REPAIR ==============
  rebuild_search_index: {
    name: 'rebuild_search_index', label: 'Rebuild Search Index',
    ps_script: 'actions/Rebuild-SearchIndex.ps1',
    confirm_level: 'risky', rollback_tier: 'B',
    snapshot_paths: ['C:\\ProgramData\\Microsoft\\Search\\Data\\Applications\\Windows\\GatherLogs'],
    estimated_duration_s: 45,
    category: 'repair', icon: '🔍',
    tooltip: 'Stops WSearch, deletes the index, restarts the service. Rebuilds index over 30-60 min in background.',
  },
  run_sfc: {
    name: 'run_sfc', label: 'Run SFC', ps_script: 'actions/Run-SFC.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 600,
    category: 'repair', icon: '🛡',
    tooltip: 'System File Checker - scans all Windows system files, repairs corrupt ones. Takes 5-15 min. Read-mostly; any repairs are logged.',
  },
  run_dism: {
    name: 'run_dism', label: 'Run DISM Repair', ps_script: 'actions/Run-DISM.ps1',
    confirm_level: 'destructive', rollback_tier: 'A',
    restore_point_description: 'PCDoctor: DISM RestoreHealth',
    estimated_duration_s: 900,
    category: 'repair', icon: '💊',
    tooltip: 'DISM /Online /Cleanup-Image /RestoreHealth. Repairs component store. Downloads from Windows Update. 10-20 min.',
  },
  trim_ssd: {
    name: 'trim_ssd', label: 'TRIM SSDs', ps_script: 'actions/Trim-SSD.ps1',
    confirm_level: 'none', rollback_tier: 'C', estimated_duration_s: 60,
    category: 'repair', icon: '💿',
    tooltip: 'Runs defrag /L on every SSD to signal free blocks. Improves sustained write speed. Safe on modern SSDs.',
  },
  generate_system_report: {
    name: 'generate_system_report', label: 'Generate System Report',
    ps_script: 'actions/Generate-System-Report.ps1',
    confirm_level: 'none', rollback_tier: 'C', estimated_duration_s: 60,
    category: 'repair', icon: '📄',
    tooltip: 'Runs msinfo32 /report + Get-ComputerInfo + driver list. Produces a .txt/.nfo bundle for support tickets.',
  },

  // ============== NETWORK ==============
  release_renew_ip: {
    name: 'release_renew_ip', label: 'Release + Renew IP',
    ps_script: 'actions/Release-RenewIP.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 15,
    category: 'network', icon: '🌍',
    tooltip: 'ipconfig /release then /renew. Forces DHCP to give you a new lease. Briefly disconnects.',
  },
  reset_winsock: {
    name: 'reset_winsock', label: 'Reset Winsock', ps_script: 'actions/Reset-WinSock.ps1',
    confirm_level: 'destructive', rollback_tier: 'A',
    restore_point_description: 'PCDoctor: Reset Winsock', reboot_required: true,
    estimated_duration_s: 10,
    category: 'network', icon: '🔌',
    tooltip: 'netsh winsock reset. Repairs the Windows networking socket layer. REQUIRES REBOOT. Use only if you have persistent networking issues.',
  },
  reset_firewall: {
    name: 'reset_firewall', label: 'Reset Firewall',
    ps_script: 'actions/Reset-Firewall.ps1',
    confirm_level: 'destructive', rollback_tier: 'A',
    restore_point_description: 'PCDoctor: Reset Firewall',
    estimated_duration_s: 15,
    category: 'network', icon: '🔥',
    tooltip: 'netsh advfirewall reset. Removes ALL custom firewall rules, returns to Windows defaults. Apps may need to re-request network access.',
  },
  flush_arp_cache: {
    name: 'flush_arp_cache', label: 'Flush ARP Cache',
    ps_script: 'actions/Flush-ARP-Cache.ps1',
    confirm_level: 'none', rollback_tier: 'C', estimated_duration_s: 2,
    category: 'network', icon: '🔀',
    tooltip: 'arp -d *. Clears the ARP table so LAN addresses resolve fresh. Use after router/switch changes.',
  },
  reset_network_adapters: {
    name: 'reset_network_adapters', label: 'Reset Network Adapters',
    ps_script: 'actions/Reset-Network-Adapters.ps1',
    confirm_level: 'destructive', rollback_tier: 'C',
    estimated_duration_s: 30,
    category: 'network', icon: '📡',
    tooltip: 'Disables and re-enables all physical network adapters. Briefly disconnects all network. Fixes stuck adapter states.',
  },
  remap_nas: {
    name: 'remap_nas', label: 'Remap NAS Drives',
    ps_script: 'actions/Remap-NAS.ps1',
    confirm_level: 'risky', rollback_tier: 'B',
    snapshot_paths: [],  // registry snapshot handled inside script
    estimated_duration_s: 30,
    category: 'network', icon: '🌐',
    tooltip: 'Re-establishes all 6 persistent SMB mappings to QNAP NAS (M:, Z:, W:, V:, B:, U:). Removes stuck sessions first.',
  },

  // ============== SERVICE / PROCESS ==============
  restart_service: {
    name: 'restart_service', label: 'Restart Service…',
    ps_script: 'actions/Restart-Service.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 10,
    category: 'service', icon: '🔁',
    tooltip: 'Restart any Windows service by name. Provides warnings for services with dependencies.',
    params_schema: {
      service_name: { type: 'string', required: true, description: 'Service name (e.g., WSearch, BITS, wuauserv)' },
    },
  },
  restart_explorer: {
    name: 'restart_explorer', label: 'Restart Explorer',
    ps_script: 'actions/Restart-Explorer.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 5,
    category: 'service', icon: '🪟',
    tooltip: 'Kills and relaunches explorer.exe. Fixes stuck taskbar/tray/File Explorer. Taskbar blinks briefly.',
  },
  restart_network_stack: {
    name: 'restart_network_stack', label: 'Restart Network Stack',
    ps_script: 'actions/Restart-Network-Stack.ps1',
    confirm_level: 'destructive', rollback_tier: 'C',
    estimated_duration_s: 20,
    category: 'service', icon: '📶',
    tooltip: 'Restarts: Dhcp, Dnscache, NlaSvc, nsi. Clears deep network issues. Briefly disconnects everything.',
  },
  kill_process: {
    name: 'kill_process', label: 'Kill Process…',
    ps_script: 'actions/Kill-Process.ps1',
    confirm_level: 'destructive', rollback_tier: 'C',
    estimated_duration_s: 3,
    category: 'service', icon: '☠',
    tooltip: 'Terminates a specified process by PID or name. Unsaved work in the target will be lost.',
    params_schema: {
      target: { type: 'string', required: true, description: 'PID number or process name (e.g., 1234 or chrome.exe)' },
    },
  },

  // ============== PERFORMANCE ==============
  compact_docker: {
    name: 'compact_docker', label: 'Compact Docker',
    ps_script: 'actions/Compact-Docker.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 120,
    category: 'perf', icon: '🐋',
    tooltip: 'docker system prune + builder prune. Removes stopped containers, unused networks/images/volumes/build cache. Frees 5-20 GB typical.',
  },
  apply_wsl_cap: {
    name: 'apply_wsl_cap', label: 'Apply WSL Memory Cap',
    ps_script: 'actions/Apply-WSLCap.ps1',
    confirm_level: 'risky', rollback_tier: 'B',
    snapshot_paths: ['C:\\Users\\greg_\\.wslconfig'],
    estimated_duration_s: 15,
    category: 'perf', icon: '🧠',
    tooltip: 'Writes C:\\Users\\greg_\\.wslconfig with memory=8GB + swap=4GB then wsl --shutdown. Prevents WSL eating all 32 GB overnight.',
  },
  fix_shell_overlays: {
    name: 'fix_shell_overlays', label: 'Fix Shell Overlays',
    ps_script: 'actions/Fix-Shell-Overlays.ps1',
    confirm_level: 'destructive', rollback_tier: 'A',
    restore_point_description: 'PCDoctor: Fix Shell Overlays',
    estimated_duration_s: 20,
    category: 'perf', icon: '🎨',
    tooltip: 'Renames redundant OneDrive/Dropbox overlay handlers (Windows only uses 15 of 23 registered). Improves File Explorer responsiveness. Reversible via restore point.',
  },
  disable_startup_item: {
    name: 'disable_startup_item', label: 'Disable Startup Item…',
    ps_script: 'actions/Disable-Startup-Item.ps1',
    confirm_level: 'destructive', rollback_tier: 'B',
    snapshot_paths: [],  // Registry key export handled in script
    estimated_duration_s: 5,
    category: 'perf', icon: '🚫',
    tooltip: 'Removes a startup Run-key entry. Exports the registry key to a snapshot so you can restore it via Revert.',
    params_schema: {
      item_name: { type: 'string', required: true, description: 'Startup entry name (e.g., GoogleDriveFS)' },
    },
  },

  // ============== SECURITY ==============
  reset_hosts_file: {
    name: 'reset_hosts_file', label: 'Reset Hosts File',
    ps_script: 'actions/Reset-HostsFile.ps1',
    confirm_level: 'destructive', rollback_tier: 'B',
    snapshot_paths: ['C:\\Windows\\System32\\drivers\\etc\\hosts'],
    estimated_duration_s: 3,
    category: 'security', icon: '🔒',
    tooltip: 'Replaces C:\\Windows\\System32\\drivers\\etc\\hosts with the Microsoft default (only 127.0.0.1 / ::1 loopback). Original backed up for revert.',
  },

  defender_quick_scan: {
    name: 'defender_quick_scan', label: 'Defender Quick Scan',
    ps_script: 'actions/Run-DefenderQuickScan.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 600,
    category: 'security', icon: '🛡',
    tooltip: 'Starts a Windows Defender Quick Scan in the background. Takes 5-15 min; does not block the UI.',
  },
  defender_full_scan: {
    name: 'defender_full_scan', label: 'Defender Full Scan',
    ps_script: 'actions/Run-DefenderFullScan.ps1',
    confirm_level: 'destructive', rollback_tier: 'C', estimated_duration_s: 7200,
    category: 'security', icon: '🔍',
    tooltip: 'Starts a Windows Defender Full Scan. Takes 1-4 hours. Uses significant CPU.',
  },
  update_defender_defs: {
    name: 'update_defender_defs', label: 'Update Defender Definitions',
    ps_script: 'actions/Update-DefenderDefs.ps1',
    confirm_level: 'none', rollback_tier: 'C', estimated_duration_s: 60,
    category: 'security', icon: '📥',
    tooltip: 'Downloads the latest Microsoft Defender threat definitions (bypassing the normal schedule).',
  },

  // ============== WINDOWS UPDATE ==============
  install_windows_updates: {
    name: 'install_windows_updates', label: 'Install All Updates',
    ps_script: 'actions/Install-WindowsUpdates.ps1',
    confirm_level: 'destructive', rollback_tier: 'A',
    restore_point_description: 'PCDoctor: Install Windows Updates',
    estimated_duration_s: 1800, category: 'update', icon: '🪟',
    tooltip: 'Downloads and installs all pending Windows Updates. May take 30+ minutes. Creates a restore point before starting.',
  },
  install_security_updates: {
    name: 'install_security_updates', label: 'Install Security Only',
    ps_script: 'actions/Install-WindowsUpdates.ps1',
    confirm_level: 'destructive', rollback_tier: 'A',
    restore_point_description: 'PCDoctor: Install Security Updates',
    estimated_duration_s: 900, category: 'update', icon: '🛡',
    tooltip: 'Installs only updates classified as Security. Creates a restore point before starting.',
  },
  repair_windows_update: {
    name: 'repair_windows_update', label: 'Repair Windows Update',
    ps_script: 'actions/Repair-WindowsUpdate.ps1',
    confirm_level: 'destructive', rollback_tier: 'C',
    estimated_duration_s: 60, category: 'update', icon: '🔧',
    tooltip: 'Stops WU services, renames SoftwareDistribution + catroot2, resets WinHTTP proxy, restarts services. Fixes stuck update issues.',
  },
  hide_kb: {
    name: 'hide_kb', label: 'Hide KB',
    ps_script: 'actions/Hide-KB.ps1',
    confirm_level: 'risky', rollback_tier: 'C', estimated_duration_s: 10,
    category: 'update', icon: '🚫',
    tooltip: 'Hides a specific Windows Update from future offerings. Provide KB ID (e.g., KB5036893).',
    params_schema: { kb_id: { type: 'string', required: true, description: 'Update KB identifier' } },
  },
  install_kb: {
    name: 'install_kb', label: 'Install KB',
    ps_script: 'actions/Install-KB.ps1',
    confirm_level: 'destructive', rollback_tier: 'A',
    restore_point_description: 'PCDoctor: Install KB',
    estimated_duration_s: 600,
    category: 'update', icon: '📥',
    tooltip: 'Installs a specific Windows Update by KB ID. Creates a restore point first.',
    params_schema: { kb_id: { type: 'string', required: true, description: 'Update KB identifier' } },
  },

  // ============== INTERNAL ==============
  create_restore_point: {
    name: 'create_restore_point', label: 'Create Restore Point',
    ps_script: 'actions/Create-RestorePoint.ps1',
    confirm_level: 'none', rollback_tier: 'none',
    estimated_duration_s: 15,
    category: 'internal', icon: '📍',
    tooltip: 'Internal: creates a Windows System Restore point. Used by the rollback manager before running Tier A actions.',
    params_schema: {
      description: { type: 'string', required: true, description: 'Restore point label' },
    },
  },
};

/** Actions shown in the Dashboard Quick Actions grid. Excludes internal + parametric ones. */
export const QUICK_ACTIONS: ActionName[] = [
  'flush_dns', 'clear_temp_files', 'rebuild_search_index', 'run_sfc', 'run_dism',
  'remap_nas', 'compact_docker', 'apply_wsl_cap', 'trim_ssd', 'release_renew_ip',
  'flush_arp_cache', 'restart_explorer',
];
