import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const saveSite = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  saveSite: (...a: unknown[]) => saveSite(...a),
}));
vi.mock('../../lib/content', () => ({
  fetchSiteSettings: vi.fn().mockResolvedValue({
    siteName: 'The Valleys at Ashebrook Residents',
    tagline: '',
    contactEmail: '',
    welcomeHeading: '',
    welcomeBody: '',
    officialMode: false,
    disclaimerText: '',
    aboutBody: '',
  }),
}));

import SiteManager from './SiteManager';

describe('SiteManager official-mode toggle', () => {
  beforeEach(() => saveSite.mockClear());

  it('renders the toggle off and saves officialMode: true after enabling it', async () => {
    render(<SiteManager />);
    const toggle = await screen.findByRole('checkbox', {
      name: /official mode/i,
    });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(saveSite).toHaveBeenCalledTimes(1));
    expect(saveSite.mock.calls[0][0]).toMatchObject({ officialMode: true });
  });

  it('saves the edited disclaimer and about copy', async () => {
    render(<SiteManager />);
    const disclaimer = await screen.findByLabelText(/disclaimer/i);
    fireEvent.change(disclaimer, {
      target: { value: 'Custom disclaimer.' },
    });
    fireEvent.change(screen.getByLabelText(/about page/i), {
      target: { value: 'Para one.\n\nPara two.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(saveSite).toHaveBeenCalledTimes(1));
    expect(saveSite.mock.calls[0][0]).toMatchObject({
      disclaimerText: 'Custom disclaimer.',
      aboutBody: 'Para one.\n\nPara two.',
    });
  });
});
