import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WizardProvider } from '../../../src/renderer/components/wizard/WizardContext.js';
import { W5Notifications } from '../../../src/renderer/components/wizard/steps/W5Notifications.js';

// ---------------------------------------------------------------------------
// Mock window.api
// ---------------------------------------------------------------------------

const mockApi = {
  testTelegram: vi.fn(),
  setSetting: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  getSettings: vi.fn().mockResolvedValue({ ok: true, data: {} }),
};

Object.defineProperty(window, 'api', { value: mockApi, writable: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderW5() {
  return render(
    <WizardProvider>
      <W5Notifications />
    </WizardProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<W5Notifications>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Telegram section title', () => {
    renderW5();
    expect(screen.getByText(/Telegram Notifications/)).toBeInTheDocument();
  });

  it('toggle defaults to disabled and shows "set this up later" text', () => {
    renderW5();
    const toggle = screen.getByRole('switch', { name: /Enable Telegram notifications/ });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/You can set this up later in Settings/)).toBeInTheDocument();
  });

  it('enabling toggle reveals token and chat ID inputs', () => {
    renderW5();
    // Initially hidden
    expect(screen.queryByLabelText('Bot Token')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Chat ID')).not.toBeInTheDocument();

    // Enable toggle
    fireEvent.click(screen.getByRole('switch', { name: /Enable Telegram notifications/ }));

    // Now visible
    expect(screen.getByLabelText('Bot Token')).toBeInTheDocument();
    expect(screen.getByLabelText('Chat ID')).toBeInTheDocument();
  });

  it('Test Connection button is present when Telegram is enabled', () => {
    renderW5();
    fireEvent.click(screen.getByRole('switch', { name: /Enable Telegram notifications/ }));
    expect(screen.getByRole('button', { name: /Test Connection/ })).toBeInTheDocument();
  });

  it('Test Connection shows success message with bot username', async () => {
    mockApi.testTelegram.mockResolvedValue({
      ok: true,
      data: { bot_username: 'my_test_bot' },
    });
    renderW5();

    // Enable telegram
    fireEvent.click(screen.getByRole('switch', { name: /Enable Telegram notifications/ }));

    // Fill in token and chat ID
    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: '123:ABC' } });
    fireEvent.change(screen.getByLabelText('Chat ID'), { target: { value: '99999' } });

    // Click test
    fireEvent.click(screen.getByRole('button', { name: /Test Connection/ }));

    await waitFor(() => {
      expect(screen.getByText(/Connected as @my_test_bot/)).toBeInTheDocument();
    });

    expect(mockApi.testTelegram).toHaveBeenCalledWith('123:ABC', '99999');
  });

  it('Test Connection shows error message on failure', async () => {
    mockApi.testTelegram.mockResolvedValue({
      ok: false,
      error: { code: 'E_AUTH', message: 'Invalid token' },
    });
    renderW5();

    fireEvent.click(screen.getByRole('switch', { name: /Enable Telegram notifications/ }));
    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: 'bad-token' } });
    fireEvent.change(screen.getByLabelText('Chat ID'), { target: { value: '12345' } });
    fireEvent.click(screen.getByRole('button', { name: /Test Connection/ }));

    await waitFor(() => {
      expect(screen.getByText('Invalid token')).toBeInTheDocument();
    });
  });

  it('Quiet Hours section renders with default values (22, 7)', () => {
    renderW5();
    expect(screen.getByText(/Quiet Hours/)).toBeInTheDocument();
    const startInput = screen.getByLabelText('Start') as HTMLInputElement;
    const endInput = screen.getByLabelText('End') as HTMLInputElement;
    expect(startInput.value).toBe('22');
    expect(endInput.value).toBe('7');
  });

  it('shows quiet hours summary text', () => {
    renderW5();
    expect(screen.getByText(/Quiet from 10:00 PM to 7:00 AM/)).toBeInTheDocument();
  });

  it('shows setup guide when Telegram is enabled', () => {
    renderW5();
    fireEvent.click(screen.getByRole('switch', { name: /Enable Telegram notifications/ }));
    expect(screen.getByText('Setup Guide')).toBeInTheDocument();
    expect(screen.getByText(/@BotFather/)).toBeInTheDocument();
  });
});
