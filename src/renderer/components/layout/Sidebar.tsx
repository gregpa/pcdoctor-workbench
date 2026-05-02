import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '@renderer/lib/ipc.js';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: '📊' },
  { to: '/security', label: 'Security', icon: '🛡' },
  { to: '/updates', label: 'Updates', icon: '🪟' },
  { to: '/tools', label: 'Tools', icon: '🧰' },
  { to: '/memtest86', label: 'MemTest86', icon: '🧠' },
  { to: '/claude', label: 'Claude', icon: '🤖' },
  { to: '/autopilot', label: 'Autopilot', icon: '🧭' },
  { to: '/weekly-review', label: 'Weekly Review', icon: '📋' },
  { to: '/forecast', label: 'Forecast', icon: '🔮' },
  { to: '/history', label: 'History', icon: '📜' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export function Sidebar() {
  // Task-18: hide Claude nav item when wizard set claude_detected='0'.
  // Default true for backward compat (existing users without wizard).
  const [claudeDetected, setClaudeDetected] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.getSettings();
        if (!alive || !r.ok) return;
        if (r.data['claude_detected'] === '0') setClaudeDetected(false);
      } catch { /* non-fatal */ }
    })();
    return () => { alive = false; };
  }, []);

  const visibleItems = claudeDetected
    ? NAV_ITEMS
    : NAV_ITEMS.filter((item) => item.to !== '/claude');

  return (
    <nav className="w-44 shrink-0 bg-surface-800 border-r border-surface-600 min-h-screen p-3 flex flex-col gap-1">
      <div className="px-2 py-3 text-[10px] text-text-secondary uppercase tracking-wider">PCDoctor</div>
      {visibleItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) =>
            `flex items-center gap-2 px-3 py-2 rounded-md text-[12px] transition ${
              isActive ? 'bg-surface-700 text-text-primary font-semibold' : 'text-text-secondary hover:bg-surface-700/50'
            }`
          }
        >
          <span>{item.icon}</span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
