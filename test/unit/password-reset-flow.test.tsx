import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const authClientMock = vi.hoisted(() => ({
  signUp: { email: vi.fn() },
  signIn: { email: vi.fn() },
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}));

vi.mock('../../src/lib/auth-client', () => ({
  authClient: authClientMock,
}));

import {
  LoginForm,
  ResetPasswordForm,
} from '../../src/components/react/AuthForms';
import AdminLogin from '../../src/components/admin/Login';

function setUrl(path: string) {
  window.history.pushState({}, '', path);
}

function fillResetForm(password: string, confirmPassword = password) {
  fireEvent.change(screen.getByLabelText(/^new password$/i), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText(/^confirm new password$/i), {
    target: { value: confirmPassword },
  });
}

function submitResetForm() {
  const button = screen.getByRole('button', { name: /set password/i });
  fireEvent.submit(button.closest('form')!);
}

describe('ResetPasswordForm', () => {
  beforeEach(() => {
    setUrl('/reset-password');
    authClientMock.resetPassword.mockResolvedValue({
      data: { status: true },
      error: null,
    });
  });

  it('shows a missing-token message when opened without a token', () => {
    render(<ResetPasswordForm />);

    expect(screen.getByText(/missing its token/i)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /request a new reset link/i }),
    ).toHaveAttribute('href', '/login');
    expect(authClientMock.resetPassword).not.toHaveBeenCalled();
  });

  it('shows an expired-token message when Better Auth redirects with INVALID_TOKEN', () => {
    setUrl('/reset-password?error=INVALID_TOKEN');

    render(<ResetPasswordForm />);

    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
  });

  it('rejects passwords shorter than the configured minimum', () => {
    setUrl('/reset-password?token=reset-token');
    render(<ResetPasswordForm />);

    fillResetForm('short');
    submitResetForm();

    expect(screen.getByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(authClientMock.resetPassword).not.toHaveBeenCalled();
  });

  it('rejects mismatched password confirmation', () => {
    setUrl('/reset-password?token=reset-token');
    render(<ResetPasswordForm />);

    fillResetForm('a-valid-password-123', 'another-password-123');
    submitResetForm();

    expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
    expect(authClientMock.resetPassword).not.toHaveBeenCalled();
  });

  it('submits the new password and token to Better Auth', async () => {
    setUrl('/reset-password?token=reset-token');
    render(<ResetPasswordForm />);

    fillResetForm('a-valid-password-123');
    submitResetForm();

    await waitFor(() =>
      expect(authClientMock.resetPassword).toHaveBeenCalledWith({
        newPassword: 'a-valid-password-123',
        token: 'reset-token',
      }),
    );
    expect(screen.getByText(/password updated/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('shows a generic failure when Better Auth rejects the reset', async () => {
    authClientMock.resetPassword.mockResolvedValue({
      data: null,
      error: { message: 'Invalid token' },
    });
    setUrl('/reset-password?token=reset-token');
    render(<ResetPasswordForm />);

    fillResetForm('a-valid-password-123');
    submitResetForm();

    expect(
      await screen.findByText(/could not reset your password/i),
    ).toBeInTheDocument();
  });
});

describe('forgot-password reset request targets', () => {
  beforeEach(() => {
    authClientMock.requestPasswordReset.mockResolvedValue({
      data: null,
      error: null,
    });
  });

  it('sends resident reset emails back to the reset-password page', async () => {
    render(<LoginForm />);

    fireEvent.change(screen.getByPlaceholderText('Email'), {
      target: { value: 'resident@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /forgot password/i }));

    await waitFor(() =>
      expect(authClientMock.requestPasswordReset).toHaveBeenCalledWith({
        email: 'resident@example.com',
        redirectTo: '/reset-password',
      }),
    );
  });

  it('sends board reset emails back to the reset-password page', async () => {
    render(<AdminLogin />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'board@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /forgot password/i }));

    await waitFor(() =>
      expect(authClientMock.requestPasswordReset).toHaveBeenCalledWith({
        email: 'board@example.com',
        redirectTo: '/reset-password',
      }),
    );
  });
});
