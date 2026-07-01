import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ContactForm reads the Web3Forms key from import.meta.env at module load, so
// each test resets modules and stubs the env before importing the component.
describe('ContactForm', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('shows a setup notice when no Web3Forms key is configured', async () => {
    vi.resetModules();
    const { default: ContactForm } = await import('./ContactForm');
    render(<ContactForm />);
    expect(screen.getByText(/Setup needed/i)).toBeInTheDocument();
  });

  it('submits the form and shows a success message', async () => {
    vi.resetModules();
    vi.stubEnv('PUBLIC_WEB3FORMS_KEY', 'test-key');
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);

    const { default: ContactForm } = await import('./ContactForm');
    render(<ContactForm />);
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
    vi.resetModules();
    vi.stubEnv('PUBLIC_WEB3FORMS_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: false, message: 'Rejected' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { default: ContactForm } = await import('./ContactForm');
    render(<ContactForm />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/your name/i), 'Jane');
    await user.type(screen.getByLabelText(/your email/i), 'jane@example.com');
    await user.type(screen.getByLabelText(/message/i), 'Hi');
    await user.click(screen.getByRole('button', { name: /send message/i }));

    expect(await screen.findByText('Rejected')).toBeInTheDocument();
  });
});
