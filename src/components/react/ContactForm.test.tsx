import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContactForm from './ContactForm';

describe('ContactForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a setup notice when no Web3Forms key is configured', () => {
    render(<ContactForm />);
    expect(screen.getByText(/Setup needed/i)).toBeInTheDocument();
  });

  it('submits the form and shows a success message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<ContactForm accessKey="test-key" />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/your name/i), 'Jane Doe');
    await user.type(screen.getByLabelText(/your email/i), 'jane@example.com');
    await user.type(screen.getByLabelText(/message/i), 'Hello board');
    await user.click(screen.getByRole('button', { name: /send message/i }));

    expect(
      await screen.findByText(/Thanks — your message has been sent/i),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.web3forms.com/submit',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows an error message when submission fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: false, message: 'Rejected' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ContactForm accessKey="test-key" />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/your name/i), 'Jane');
    await user.type(screen.getByLabelText(/your email/i), 'jane@example.com');
    await user.type(screen.getByLabelText(/message/i), 'Hi');
    await user.click(screen.getByRole('button', { name: /send message/i }));

    expect(await screen.findByText('Rejected')).toBeInTheDocument();
  });
});
