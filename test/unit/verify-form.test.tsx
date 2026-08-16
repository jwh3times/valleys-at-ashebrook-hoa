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

const UNIFORM_MESSAGE =
  'If the information matches our records, a code has been sent.';

function fillRequestForm(address = '1 Test St', name = 'Jamie Homeowner') {
  fireEvent.change(screen.getByPlaceholderText(/property address/i), {
    target: { value: address },
  });
  fireEvent.change(screen.getByPlaceholderText(/full name/i), {
    target: { value: name },
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

describe('VerifyPropertyForm request submission', () => {
  it('requires a full name alongside the address before submitting', async () => {
    const fetch = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ ok: true, message: UNIFORM_MESSAGE }));
    render(<VerifyPropertyForm />);

    const nameInput = screen.getByPlaceholderText(/full name/i);
    expect(nameInput).toBeRequired();
    expect(nameInput).toHaveAttribute('autoComplete', 'name');

    fireEvent.change(screen.getByPlaceholderText(/property address/i), {
      target: { value: '1 Test St' },
    });
    // Name left blank — the browser would block native submission, but the
    // handler itself must also send it once filled in below.
    fireEvent.change(nameInput, { target: { value: 'Jamie Homeowner' } });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [, init] = fetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({
      address: '1 Test St',
      name: 'Jamie Homeowner',
      channel: 'email',
      turnstileToken: 'spent-token',
    });
  });

  it('blocks submit and does not reset when no Turnstile token exists', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    delete (window as Win).turnstileToken;

    render(<VerifyPropertyForm />);
    fillRequestForm();
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    expect(fetch).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/complete the captcha/i)).toBeInTheDocument(),
    );
    expect((window as Win).turnstile!.reset).not.toHaveBeenCalled();
  });

  it('renders the uniform server message and advances to the confirm stage on any 200', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({ ok: true, message: UNIFORM_MESSAGE }),
    );
    render(<VerifyPropertyForm />);
    fillRequestForm();
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/6-digit code/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(UNIFORM_MESSAGE)).toBeInTheDocument();
  });

  it('resets the Turnstile widget after a successful send', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({ ok: true, message: UNIFORM_MESSAGE }),
    );
    render(<VerifyPropertyForm />);
    fillRequestForm();
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/6-digit code/i)).toBeInTheDocument(),
    );
    expect((window as Win).turnstile!.reset).toHaveBeenCalled();
    expect((window as Win).turnstileToken).toBeUndefined();
  });

  it('shows a JSON 400 message and resets the spent token without advancing stage', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          message: 'Could not validate the captcha. Complete it again.',
        },
        400,
      ),
    );
    render(<VerifyPropertyForm />);
    fillRequestForm();
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/could not validate the captcha/i),
      ).toBeInTheDocument(),
    );
    expect((window as Win).turnstile!.reset).toHaveBeenCalled();
    expect((window as Win).turnstileToken).toBeUndefined();
    // A 400 is a gate failure, not a roster oracle path — the form stays put.
    expect(
      screen.queryByPlaceholderText(/6-digit code/i),
    ).not.toBeInTheDocument();
  });
});

describe('VerifyPropertyForm review action', () => {
  it('is hidden before any request has been made', () => {
    render(<VerifyPropertyForm />);
    expect(
      screen.queryByRole('button', { name: /ask the board to review/i }),
    ).not.toBeInTheDocument();
  });

  it('appears after a request and posts address+name to /api/verify/review', async () => {
    const fetch = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, message: UNIFORM_MESSAGE }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          message: 'Your request was sent to the board.',
        }),
      );

    render(<VerifyPropertyForm />);
    fillRequestForm('1 Test St', 'Jamie Homeowner');
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    const reviewButton = await screen.findByRole('button', {
      name: /ask the board to review/i,
    });
    fireEvent.click(reviewButton);

    await waitFor(() =>
      expect(
        screen.getByText(/your request was sent to the board/i),
      ).toBeInTheDocument(),
    );

    const [, init] = fetch.mock.calls[1]!;
    expect(fetch.mock.calls[1]![0]).toBe('/api/verify/review');
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({ address: '1 Test St', name: 'Jamie Homeowner' });
  });

  it('stays visible and posts a review request from the confirm stage too', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, message: UNIFORM_MESSAGE }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          message: 'Your request was sent to the board.',
        }),
      );

    render(<VerifyPropertyForm />);
    fillRequestForm();
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    await screen.findByPlaceholderText(/6-digit code/i);

    const reviewButton = screen.getByRole('button', {
      name: /ask the board to review/i,
    });
    fireEvent.click(reviewButton);

    await waitFor(() =>
      expect(
        screen.getByText(/your request was sent to the board/i),
      ).toBeInTheDocument(),
    );
  });
});

describe('VerifyPropertyForm confirm flow', () => {
  it('shows a success state with a link to the resident documents', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, message: UNIFORM_MESSAGE }),
      ) // request → confirm stage
      .mockResolvedValueOnce(jsonResponse({ ok: true })); // confirm → success

    render(<VerifyPropertyForm />);
    fillRequestForm();
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

  it('shows an invalid-code message on a failed confirm', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, message: UNIFORM_MESSAGE }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, reason: 'invalid' }, 400),
      );

    render(<VerifyPropertyForm />);
    fillRequestForm();
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    const codeInput = await screen.findByPlaceholderText(/6-digit code/i);
    fireEvent.change(codeInput, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() =>
      expect(screen.getByText(/code invalid or expired/i)).toBeInTheDocument(),
    );
  });
});
