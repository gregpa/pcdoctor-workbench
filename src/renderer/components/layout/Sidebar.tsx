import { NavLink } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: '📊' },
  { to: '/security', label: 'Security', icon: '🛡' },
  { to: '/weekly-review', label: 'Weekly Review', icon: '📋' },
  { to: '/forecast', label: 'Forecast', icon: '🔮' },
  { to: '/history', label: 'History', icon: '📜' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export function Sidebar() {
  return (
    <nav className="w-44 shrink-0 bg-surface-800 border-r border-surface-600 min-h-screen p-3 flex flex-col gap-1">
      <div className="px-2 py-3 text-[10px] text-text-secondary uppercase tracking-wider">PCDoctor</div>
      {NAV_ITEMS.map((item) => (
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
