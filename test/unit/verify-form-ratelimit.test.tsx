import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VerifyPropertyForm } from '../../src/components/react/AuthForms';

type Win = typeof window & {
  turnstileToken?: string;
  turnstile?: { reset: () => void };
};

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as Win).turnstile;
  delete (window as Win).turnstileToken;
});

// #219 D2: rate limits are no longer a distinguishable response — a
// rate-limited request answers the exact same 200 uniform body as a matched
// send, so this file no longer has a 429/rateLimited case to assert. What's
// left: the form renders whatever byte-identical message the server sends,
// with no local rate-limit branching of its own.
describe('VerifyPropertyForm uniform response rendering', () => {
  it('renders the server-provided uniform message on 200 with no local branching', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          message:
            'If the information matches our records, a code has been sent.',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    (window as Win).turnstile = { reset: vi.fn() };
    (window as Win).turnstileToken = 'spent-token';

    render(<VerifyPropertyForm />);
    fireEvent.change(screen.getByPlaceholderText(/property address/i), {
      target: { value: '1 Test St' },
    });
    fireEvent.change(screen.getByPlaceholderText(/full name/i), {
      target: { value: 'Jamie Homeowner' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() =>
      expect(
        screen.getByText(
          /if the information matches our records, a code has been sent/i,
        ),
      ).toBeInTheDocument(),
    );
    // The uniform response always advances the stage — there is no
    // "matched vs. not" branch left for the component to take.
    expect(screen.getByPlaceholderText(/6-digit code/i)).toBeInTheDocument();
  });
});
