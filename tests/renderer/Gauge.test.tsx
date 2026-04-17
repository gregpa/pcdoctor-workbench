import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Gauge } from '../../src/renderer/components/dashboard/Gauge.js';

describe('<Gauge>', () => {
  it('renders the display text', () => {
    render(<Gauge value={82} display="82°C" subtext="THROTTLING" severity="warn" label="CPU" />);
    expect(screen.getByText('82°C')).toBeTruthy();
    expect(screen.getByText('THROTTLING')).toBeTruthy();
  });

  it('sets value arc stroke-dasharray proportional to value', () => {
    // 270° arc length on r=70 circle = 329.867
    // value=50 => dash length = 164.93
    const { container } = render(
      <Gauge value={50} display="50%" subtext="" severity="good" label="" />,
    );
    const circles = container.querySelectorAll('circle');
    const valueArc = circles[circles.length - 1]; // last arc is value arc
    const da = valueArc.getAttribute('stroke-dasharray') ?? '';
    const [fill] = da.split(/\s+/).map(Number);
    expect(fill).toBeGreaterThan(160);
    expect(fill).toBeLessThan(170);
  });

  it('clamps value above 100 to 100', () => {
    const { container } = render(
      <Gauge value={150} display="150%" subtext="" severity="crit" label="" />,
    );
    const circles = container.querySelectorAll('circle');
    const valueArc = circles[circles.length - 1];
    const da = valueArc.getAttribute('stroke-dasharray') ?? '';
    const [fill] = da.split(/\s+/).map(Number);
    // Should match the full 270° background arc length (329.867)
    expect(fill).toBeGreaterThan(329);
    expect(fill).toBeLessThan(331);
  });

  it('applies severity color to the value stroke', () => {
    const { container } = render(<Gauge value={50} display="50%" subtext="" severity="crit" label="" />);
    const circles = container.querySelectorAll('circle');
    const valueArc = circles[circles.length - 1];
    expect(valueArc.getAttribute('stroke')).toBe('#ef4444');
  });
});
