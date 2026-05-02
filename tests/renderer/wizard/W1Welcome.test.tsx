import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WizardProvider, useWizard } from '../../../src/renderer/components/wizard/WizardContext.js';
import { W1Welcome } from '../../../src/renderer/components/wizard/steps/W1Welcome.js';

function renderWithWizard() {
  return render(
    <WizardProvider>
      <W1Welcome />
    </WizardProvider>,
  );
}

describe('<W1Welcome>', () => {
  it('renders the headline', () => {
    renderWithWizard();
    expect(screen.getByText('Welcome to PCDoctor Workbench')).toBeInTheDocument();
  });

  it('renders all 5 feature bullets', () => {
    renderWithWizard();
    expect(screen.getByText(/Real-time system health monitoring/)).toBeInTheDocument();
    expect(screen.getByText(/Automated security scanning/)).toBeInTheDocument();
    expect(screen.getByText(/NAS drive management/)).toBeInTheDocument();
    expect(screen.getByText(/Autopilot maintenance/)).toBeInTheDocument();
    expect(screen.getByText(/Weekly health reports/)).toBeInTheDocument();
  });

  it('renders the "Get Started" button', () => {
    renderWithWizard();
    const btn = screen.getByRole('button', { name: /Get Started/ });
    expect(btn).toBeInTheDocument();
  });

  it('clicking "Get Started" advances the wizard (calls next)', () => {
    // Render a mini harness that also shows currentStep so we can assert the advance.
    function StepInspector() {
      const { state } = useWizard();
      return (
        <>
          <span data-testid="step">{state.currentStep}</span>
          <span data-testid="completed">{state.completedSteps.has(0) ? 'yes' : 'no'}</span>
        </>
      );
    }

    render(
      <WizardProvider>
        <W1Welcome />
        <StepInspector />
      </WizardProvider>,
    );

    expect(screen.getByTestId('step').textContent).toBe('0');
    expect(screen.getByTestId('completed').textContent).toBe('no');

    fireEvent.click(screen.getByRole('button', { name: /Get Started/ }));

    expect(screen.getByTestId('step').textContent).toBe('1');
    expect(screen.getByTestId('completed').textContent).toBe('yes');
  });
});
