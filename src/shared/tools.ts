export type ToolCategory = 'hardware' | 'security' | 'forensics' | 'disk' | 'diagnostic' | 'native';

export interface ToolLaunchMode {
  id: string;
  label: string;
  args: string[];
  detached?: boolean;
  confirm?: 'warn-duration' | 'warn-stress' | 'warn-reboot' | 'none';
}

export interface ToolDefinition {
  id: string;
  name: string;
  category: ToolCategory;
  description: string;
  publisher: string;
  detect_paths: string[];           // absolute Windows paths (env vars allowed)
  winget_id?: string;
  download_url?: string;
  /** For MSIX/Store apps: full AppID (e.g. "DellInc.AlienwareCommandCenter_htrsf667h5kn2!App").
   *  When present, tool is launched via explorer.exe shell:AppsFolder\<AppID>
   *  and detected via Get-AppxPackage instead of filesystem probe. */
  msix_app_id?: string;
  /** For MSIX apps: PackageFamilyName (e.g. "DellInc.AlienwareCommandCenter_htrsf667h5kn2").
   *  Used for fast filesystem-based install detection (Packages dir). */
  msix_package_family?: string;
  launch_modes: ToolLaunchMode[];
  expected_duration_min?: number;
  expected_duration_max?: number;
  icon: string;
}

export const TOOLS: Record<string, ToolDefinition> = {
  // ============ HARDWARE ============
  occt: {
    id: 'occt', name: 'OCCT', category: 'hardware',
    description: 'CPU/GPU/PSU stress testing', publisher: 'OCBase',
    detect_paths: [
      'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe',
      'C:\\Program Files\\OCCT\\OCCT.exe',
      'C:\\Program Files (x86)\\OCCT\\OCCT.exe',
    ],
    launch_modes: [
      { id: 'gui', label: 'Open (interactive)', args: [], detached: true },
    ],
    icon: '🔥',
  },
  hwinfo64: {
    id: 'hwinfo64', name: 'HWiNFO64', category: 'hardware',
    description: 'Sensor monitoring + CSV logging', publisher: 'Martin Malik',
    detect_paths: [
      'C:\\Program Files\\HWiNFO64\\HWiNFO64.exe',
      'C:\\ProgramData\\PCDoctor\\tools\\HWiNFO64\\HWiNFO64.exe',
    ],
    launch_modes: [
      { id: 'gui', label: 'Open (sensors-only mode)', args: ['-so'], detached: true },
    ],
    icon: '🌡',
  },
  awcc: {
    id: 'awcc', name: 'Alienware Command Center', category: 'hardware',
    description: 'Thermal, fan curve, lighting, OC controls', publisher: 'Dell Inc.',
    detect_paths: [],
    msix_app_id: 'DellInc.AlienwareCommandCenter_htrsf667h5kn2!App',
    msix_package_family: 'DellInc.AlienwareCommandCenter_htrsf667h5kn2',
    launch_modes: [{ id: 'gui', label: 'Open Command Center', args: [], detached: true }],
    icon: '👽',
  },
  dcu: {
    id: 'dcu', name: 'Dell Command Update', category: 'diagnostic',
    description: 'Dell firmware + driver updater (BIOS, chipset, AWCC, etc.)', publisher: 'Dell Inc.',
    detect_paths: [
      'C:\\Program Files (x86)\\Dell\\CommandUpdate\\DellCommandUpdate.exe',
      'C:\\Program Files\\Dell\\CommandUpdate\\DellCommandUpdate.exe',
    ],
    winget_id: 'Dell.CommandUpdate',
    launch_modes: [
      { id: 'gui', label: 'Open Dell Command Update', args: [], detached: true },
    ],
    icon: '💻',
  },
  'gpu-z': {
    id: 'gpu-z', name: 'GPU-Z', category: 'hardware',
    description: 'GPU information + logging', publisher: 'TechPowerUp',
    detect_paths: [
      'C:\\Program Files\\TechPowerUp\\GPU-Z\\GPU-Z.exe',
      'C:\\Program Files (x86)\\TechPowerUp\\GPU-Z\\GPU-Z.exe',
    ],
    winget_id: 'TechPowerUp.GPU-Z',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '📊',
  },
  'cpu-z': {
    id: 'cpu-z', name: 'CPU-Z', category: 'hardware',
    description: 'CPU + memory information', publisher: 'CPUID',
    detect_paths: [
      'C:\\Program Files\\CPUID\\CPU-Z\\cpuz.exe',
      'C:\\Program Files (x86)\\CPUID\\CPU-Z\\cpuz.exe',
    ],
    winget_id: 'CPUID.CPU-Z',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '💻',
  },
  'librehardwaremonitor': {
    // v2.4.31 (v2.4.32 expanded): LHM installs per-user via winget, so
    // its exe lives under %LOCALAPPDATA% not Program Files. Must match
    // this path exactly or the Launch button appears to succeed but
    // launches nothing (winget's silent scoop install pattern).
    //
    // v2.4.32: LHM 0.9+ removed the WMI provider in favor of the
    // HTTP API on port 8085 (enable via Options -> Remote Web Server
    // -> Run). Get-Temperatures.ps1 queries that endpoint for CPU
    // temperatures when it responds; falls back to MSAcpi + cache
    // otherwise.
    id: 'librehardwaremonitor', name: 'LibreHardwareMonitor', category: 'hardware',
    description: 'Open-source sensor monitor. Enable Options -> Remote Web Server -> Run for PCDoctor to read CPU / mobo / fan / per-core temps via HTTP.',
    publisher: 'LibreHardwareMonitor',
    detect_paths: [
      '%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\LibreHardwareMonitor.LibreHardwareMonitor_Microsoft.Winget.Source_8wekyb3d8bbwe\\LibreHardwareMonitor.exe',
      'C:\\Program Files\\LibreHardwareMonitor\\LibreHardwareMonitor.exe',
      'C:\\Program Files (x86)\\LibreHardwareMonitor\\LibreHardwareMonitor.exe',
    ],
    winget_id: 'LibreHardwareMonitor.LibreHardwareMonitor',
    launch_modes: [{ id: 'gui', label: 'Open (enable Remote Web Server after)', args: [], detached: true }],
    icon: '🌡',
  },

  // ============ DISK ============
  treesize: {
    id: 'treesize', name: 'TreeSize Free', category: 'disk',
    description: 'Visual disk space explorer', publisher: 'JAM Software',
    detect_paths: [
      'C:\\Program Files\\JAM Software\\TreeSize Free\\TreeSizeFree.exe',
      'C:\\Program Files (x86)\\JAM Software\\TreeSize Free\\TreeSizeFree.exe',
    ],
    winget_id: 'JAMSoftware.TreeSize.Free',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '🌳',
  },
  crystaldiskinfo: {
    id: 'crystaldiskinfo', name: 'CrystalDiskInfo', category: 'disk',
    description: 'SMART health GUI viewer', publisher: 'Crystal Dew World',
    detect_paths: [
      'C:\\Program Files\\CrystalDiskInfo\\DiskInfo64.exe',
      'C:\\Program Files (x86)\\CrystalDiskInfo\\DiskInfo64.exe',
    ],
    winget_id: 'CrystalDewWorld.CrystalDiskInfo',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '💾',
  },
  crystaldiskmark: {
    id: 'crystaldiskmark', name: 'CrystalDiskMark', category: 'disk',
    description: 'Disk benchmark tool', publisher: 'Crystal Dew World',
    detect_paths: [
      'C:\\Program Files\\CrystalDiskMark8\\DiskMark64.exe',
      'C:\\Program Files (x86)\\CrystalDiskMark8\\DiskMark64.exe',
    ],
    winget_id: 'CrystalDewWorld.CrystalDiskMark',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '📏',
  },

  // ============ SECURITY / ANTI-MALWARE ============
  mbam: {
    id: 'mbam', name: 'Malwarebytes Free', category: 'security',
    description: 'Second-opinion anti-malware scan', publisher: 'Malwarebytes',
    detect_paths: [
      'C:\\Program Files\\Malwarebytes\\Anti-Malware\\mbam.exe',
      'C:\\Program Files (x86)\\Malwarebytes\\Anti-Malware\\mbam.exe',
    ],
    winget_id: 'Malwarebytes.Malwarebytes',
    launch_modes: [{ id: 'gui', label: 'Open Malwarebytes', args: [], detached: true }],
    icon: '🛡',
  },
  adwcleaner: {
    id: 'adwcleaner', name: 'AdwCleaner', category: 'security',
    description: 'Adware and PUP cleaner', publisher: 'Malwarebytes',
    detect_paths: [
      'C:\\Program Files\\AdwCleaner\\adwcleaner.exe',
      'C:\\ProgramData\\PCDoctor\\tools\\adwcleaner.exe',
    ],
    winget_id: 'Malwarebytes.AdwCleaner',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '🧽',
  },
  mss: {
    id: 'mss', name: 'Microsoft Safety Scanner', category: 'security',
    description: 'On-demand Microsoft malware scan (re-download every 10 days)',
    publisher: 'Microsoft',
    detect_paths: ['C:\\ProgramData\\PCDoctor\\tools\\msert.exe'],
    download_url: 'https://go.microsoft.com/fwlink/?LinkId=212732',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '🩺',
  },

  // ============ FORENSICS / SYSINTERNALS ============
  autoruns: {
    id: 'autoruns', name: 'Autoruns', category: 'forensics',
    description: 'All autostart entries across the system', publisher: 'Sysinternals',
    detect_paths: [
      'C:\\ProgramData\\PCDoctor\\tools\\Autoruns\\Autoruns64.exe',
      'C:\\Program Files\\Sysinternals\\Autoruns64.exe',
      'C:\\Program Files\\Sysinternals Suite\\Autoruns64.exe',
    ],
    winget_id: 'Microsoft.Sysinternals.Autoruns',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '🚀',
  },
  procexp: {
    id: 'procexp', name: 'Process Explorer', category: 'forensics',
    description: 'Rich replacement for Task Manager', publisher: 'Sysinternals',
    detect_paths: [
      'C:\\Program Files\\Sysinternals\\procexp64.exe',
      'C:\\Program Files\\Sysinternals Suite\\procexp64.exe',
    ],
    winget_id: 'Microsoft.Sysinternals.ProcessExplorer',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '🔎',
  },
  procmon: {
    id: 'procmon', name: 'Process Monitor', category: 'forensics',
    description: 'File/registry/network activity tracer', publisher: 'Sysinternals',
    detect_paths: [
      'C:\\Program Files\\Sysinternals\\Procmon64.exe',
      'C:\\Program Files\\Sysinternals Suite\\Procmon64.exe',
    ],
    winget_id: 'Microsoft.Sysinternals.ProcessMonitor',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '📡',
  },
  tcpview: {
    id: 'tcpview', name: 'TCPView', category: 'forensics',
    description: 'Active TCP/UDP connections', publisher: 'Sysinternals',
    detect_paths: [
      'C:\\Program Files\\Sysinternals\\tcpview64.exe',
      'C:\\Program Files\\Sysinternals Suite\\tcpview64.exe',
    ],
    winget_id: 'Microsoft.Sysinternals.TCPView',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '🌐',
  },

  // ============ DIAGNOSTIC ============
  rufus: {
    id: 'rufus', name: 'Rufus', category: 'diagnostic',
    description: 'USB imaging tool (MemTest86, Ventoy, Windows ISO)', publisher: 'Pete Batard',
    detect_paths: [
      'C:\\Program Files\\Rufus\\rufus.exe',
    ],
    winget_id: 'Rufus.Rufus',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '💿',
  },
  bluescreenview: {
    id: 'bluescreenview', name: 'BlueScreenView', category: 'diagnostic',
    description: 'Analyze minidump files', publisher: 'NirSoft',
    detect_paths: [
      'C:\\Program Files\\NirSoft\\BlueScreenView\\BlueScreenView.exe',
      'C:\\Program Files (x86)\\NirSoft\\BlueScreenView\\BlueScreenView.exe',
    ],
    winget_id: 'NirSoft.BlueScreenView',
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '💥',
  },

  // ============ NATIVE (always available) ============
  msinfo32: {
    id: 'msinfo32', name: 'System Information', category: 'native',
    description: 'Windows system info snapshot', publisher: 'Microsoft',
    detect_paths: ['C:\\Windows\\System32\\msinfo32.exe'],
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: 'ℹ',
  },
  perfmon: {
    id: 'perfmon', name: 'Performance Monitor', category: 'native',
    description: 'Performance counters + reliability', publisher: 'Microsoft',
    detect_paths: ['C:\\Windows\\System32\\perfmon.exe'],
    launch_modes: [
      { id: 'gui', label: 'Open', args: [], detached: true },
      { id: 'rel', label: 'Reliability History', args: ['/rel'], detached: true },
    ],
    icon: '📈',
  },
  eventvwr: {
    id: 'eventvwr', name: 'Event Viewer', category: 'native',
    description: 'System + application event logs', publisher: 'Microsoft',
    detect_paths: ['C:\\Windows\\System32\\eventvwr.msc'],
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '📋',
  },
  resmon: {
    id: 'resmon', name: 'Resource Monitor', category: 'native',
    description: 'CPU/RAM/disk/network live usage', publisher: 'Microsoft',
    detect_paths: ['C:\\Windows\\System32\\resmon.exe'],
    launch_modes: [{ id: 'gui', label: 'Open', args: [], detached: true }],
    icon: '⚡',
  },
};

export const TOOL_CATEGORIES: { id: ToolCategory; label: string }[] = [
  { id: 'hardware', label: 'Hardware' },
  { id: 'security', label: 'Security' },
  { id: 'forensics', label: 'Forensics' },
  { id: 'disk', label: 'Disk' },
  { id: 'diagnostic', label: 'Diagnostic' },
  { id: 'native', label: 'Windows Native' },
];
