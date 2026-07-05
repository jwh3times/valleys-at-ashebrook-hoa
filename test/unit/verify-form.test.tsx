import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VerifyPropertyForm } from '../../src/components/react/AuthForms';

type Win = typeof window & {
  turnstileToken?: string;
  turnstile?: { reset: () => void };
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  (window as Win).turnstile = { reset: vi.fn() };
  (window as Win).turnstileToken = 'spent-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as Win).turnstile;
  delete (window as Win).turnstileToken;
});

describe('VerifyPropertyForm Turnstile handling', () => {
  it('resets the widget and clears the spent token after a 429', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({ rateLimited: true, message: 'Slow down.' }, 429),
    );
    render(<VerifyPropertyForm />);
    fireEvent.change(screen.getByPlaceholderText(/property address/i), {
      target: { value: '1 Test St' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() =>
      expect((window as Win).turnstile!.reset).toHaveBeenCalled(),
    );
    expect((window as Win).turnstileToken).toBeUndefined();
  });

  it('resets the widget after a successful send', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
    render(<VerifyPropertyForm />);
    fireEvent.change(screen.getByPlaceholderText(/property address/i), {
      target: { value: '1 Test St' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    // Advances to the confirm stage...
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/6-digit code/i)).toBeInTheDocument(),
    );
    // ...and the spent token was reset for any future request.
    expect((window as Win).turnstile!.reset).toHaveBeenCalled();
    expect((window as Win).turnstileToken).toBeUndefined();
  });
});

describe('VerifyPropertyForm post-confirm success', () => {
  it('shows a success state with a link to the resident documents', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ok: true })) // request → confirm stage
      .mockResolvedValueOnce(jsonResponse({ ok: true })); // confirm → success

    render(<VerifyPropertyForm />);
    fireEvent.change(screen.getByPlaceholderText(/property address/i), {
      target: { value: '1 Test St' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    const codeInput = await screen.findByPlaceholderText(/6-digit code/i);
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() =>
      expect(screen.getByText(/homeowner access/i)).toBeInTheDocument(),
    );
    const link = screen.getByRole('link', { name: /documents/i });
    expect(link).toHaveAttribute('href', '/documents');
  });
});
