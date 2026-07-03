import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VerifyPropertyForm } from '../../src/components/react/AuthForms';

afterEach(() => vi.restoreAllMocks());

describe('VerifyPropertyForm rate-limit message', () => {
  it('shows the server message on a 429', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          rateLimited: true,
          message: 'Please wait a couple of minutes.',
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    );
    render(<VerifyPropertyForm />);
    fireEvent.change(screen.getByPlaceholderText(/property address/i), {
      target: { value: '1 Test St' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/please wait a couple of minutes/i),
      ).toBeInTheDocument(),
    );
  });
});
