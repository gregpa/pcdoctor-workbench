import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ----------------------------------------------------------------
        // Existing tokens (PRESERVED — every existing className still works)
        // ----------------------------------------------------------------
        surface: {
          900: '#0d1117',
          800: '#161b22',
          700: '#21262d',
          600: '#30363d',
          // v2.5.0 (UI restyle): new tokens added below; old 600-900
          // numerics stay so the existing className sweep across the
          // codebase keeps building. Stage 3+ swaps usage gradually.
          base:        '#0a0e1a',  // body background — deep navy, almost black
          panel:       '#11172a',  // card / panel base color
          'panel-translucent': 'rgba(17, 23, 42, 0.85)',  // glassmorphism (with backdrop-blur-md)
          elevated:    '#1a2138',  // slightly lifted panels (modal, hover state)
        },
        text: {
          primary:   '#e6edf3',
          secondary: '#8b949e',
          // v2.5.0 — slightly cooler primary, slightly violet-tinted muted.
          'primary-new':   '#e8ecf5',
          'secondary-new': '#7d8aaa',
        },
        status: {
          // FUNCTIONAL INDICATORS — NOT a UI restyle target.
          // Greg's D1 brief: "keep full color palate for all graphics
          // as they are now." Tier badges (T1=green, T2=amber, T3=red),
          // outcome chips (auto_run/error/alerted/suppressed), severity
          // tones (good/warn/crit), all trend chart + gauge colors,
          // remain unchanged. Do NOT replace these with the new accent
          // tokens below — those are decorative chrome only.
          good: '#22c55e',
          warn: '#f59e0b',
          crit: '#ef4444',
          info: '#3b82f6',
        },
        // ----------------------------------------------------------------
        // v2.5.0 (UI restyle, Stage 1) — NEW decorative-chrome tokens.
        // These are added but NOT YET used by any component. Stage 2-5
        // sweep through swapping `bg-surface-800` → `bg-surface-panel`
        // etc. component by component, with checkpoint commits between
        // stages so any visual regression is one `git revert` away.
        // ----------------------------------------------------------------
        border: {
          default: '#1e2745',  // subtle border
        },
        glow: {
          violet: 'rgba(157, 107, 255, 0.4)',  // hover / focus glow
          cyan:   'rgba(57, 217, 255, 0.3)',   // connector accent
        },
        accent: {
          violet: '#9d6bff',  // primary brand accent (decorative)
          cyan:   '#39d9ff',  // secondary accent (connectors, chips, focus rings)
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      // v2.5.0 Stage 1 — backdrop-blur utility cap. Greg's D3 (b): both
      // glassmorphism + dotted grid, subtle. The 8px hard cap (per the
      // v2.4.x integrated-graphics constraint already documented) is
      // enforced by NEVER using a higher value than `backdrop-blur-md`
      // in the codebase. Tailwind's default scale already maps `md` →
      // 12px which exceeds the cap; override to 8px here so the
      // existing utility name remains semantically correct after the
      // restyle.
      backdropBlur: {
        md: '8px',
      },
      // v2.5.0 Stage 1 — box-shadow tokens for the violet/cyan glow
      // utilities. Used in Stage 3+ component sweeps for hover/focus
      // states. Names match the color tokens above.
      boxShadow: {
        'glow-violet': '0 0 12px rgba(157, 107, 255, 0.35)',
        'glow-cyan':   '0 0 12px rgba(57, 217, 255, 0.30)',
      },
    },
  },
  plugins: [],
} satisfies Config;
