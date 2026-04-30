import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  text: string;
  children: ReactNode;
}

/**
 * Hover tooltip that escapes ancestor `contain: paint` (panel-contain on
 * pcd-panel). Pre-v2.5.10 this used CSS-only `group-hover` + absolute
 * positioning — the tooltip overlay was a descendant of any pcd-panel it
 * sat in, and Chromium clipped it at the panel's paint box even with
 * z-50. The fix portals the overlay to document.body and anchors it to
 * the trigger via getBoundingClientRect() in fixed (viewport) coords.
 *
 * Trade-off: loses the CSS opacity transition (was group-hover:opacity-100
 * transition-opacity). Acceptable; the show/hide is fast enough that the
 * pop-in isn't jarring.
 */
export function Tooltip({ text, children }: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!hover || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({ top: r.top - 8, left: r.left + r.width / 2 });
  }, [hover]);

  // Defensive cleanup: if the component unmounts while hover is true
  // (parent conditionally drops the wrapped trigger mid-hover), force
  // hover false so the portal unmounts cleanly. React unmounts portals
  // with their owner anyway, but this guards reconciliation edge cases.
  useEffect(() => () => setHover(false), []);

  return (
    <>
      <span
        ref={triggerRef}
        className="relative inline-flex"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {children}
      </span>
      {hover && pos && createPortal(
        <span
          role="tooltip"
          className="fixed -translate-x-1/2 -translate-y-full
                     bg-surface-700 border border-status-info/50 text-text-primary
                     px-3 py-2 rounded-md text-xs font-normal leading-relaxed
                     min-w-[180px] max-w-[280px] w-max
                     shadow-lg pointer-events-none whitespace-pre-line z-50"
          style={{ top: pos.top, left: pos.left }}
        >
          {text}
        </span>,
        document.body,
      )}
    </>
  );
}
