import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const saveSite = vi.fn().mockResolvedValue(undefined);
const setSiteGate = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  saveSite: (...a: unknown[]) => saveSite(...a),
  setSiteGate: (...a: unknown[]) => setSiteGate(...a),
}));

const defaultSettings = {
  siteName: 'The Valleys at Ashebrook Residents',
  tagline: '',
  contactEmail: '',
  welcomeHeading: '',
  welcomeBody: '',
  officialMode: false,
  liveVotingEnabled: false,
  disclaimerText: '',
  aboutBody: '',
};

const fetchSiteSettings = vi.fn().mockResolvedValue(defaultSettings);
vi.mock('../../lib/content', () => ({
  fetchSiteSettings: (...a: unknown[]) => fetchSiteSettings(...a),
}));

import SiteManager from './SiteManager';

// #363: officialMode/liveVotingEnabled moved off the whole-blob PUT
// (`saveSite`) onto the audited compare-and-swap transition (`setSiteGate`).
// These tests pin that the toggles call the transition — never the blob
// save — with the value the form loaded as `expected`, that a conflict
// surfaces the server's message and reloads, and that the presentation
// fields are unaffected and still travel through `saveSite`.
describe('SiteManager gate toggles', () => {
  beforeEach(() => {
    saveSite.mockClear();
    setSiteGate.mockClear();
    setSiteGate.mockResolvedValue(undefined);
    fetchSiteSettings.mockClear();
    fetchSiteSettings.mockResolvedValue({ ...defaultSettings });
  });

  it('calls the audited transition, not the blob save, when official mode is toggled on', async () => {
    render(<SiteManager />);
    const toggle = await screen.findByRole('checkbox', {
      name: /official mode/i,
    });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(setSiteGate).toHaveBeenCalledTimes(1));
    expect(setSiteGate).toHaveBeenCalledWith('officialMode', false, true);
    expect(saveSite).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/official mode turned on/i)).toBeInTheDocument(),
    );
  });

  it('calls the audited transition when live voting is toggled on', async () => {
    render(<SiteManager />);
    const toggle = await screen.findByRole('checkbox', {
      name: /live voting/i,
    });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(setSiteGate).toHaveBeenCalledTimes(1));
    expect(setSiteGate).toHaveBeenCalledWith('liveVotingEnabled', false, true);
    expect(saveSite).not.toHaveBeenCalled();
  });

  it('shows the server conflict message and reloads when the gate changed first', async () => {
    setSiteGate.mockRejectedValueOnce(
      new Error(
        'officialMode was changed by someone else — reload and try again',
      ),
    );
    render(<SiteManager />);
    const toggle = await screen.findByRole('checkbox', {
      name: /official mode/i,
    });
    const loadsBeforeClick = fetchSiteSettings.mock.calls.length;

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(
        screen.getByText(/officialMode was changed by someone else/i),
      ).toBeInTheDocument(),
    );
    // Reloaded after the conflict too, not only after success — the
    // checkbox must settle back to whatever is actually stored.
    expect(fetchSiteSettings.mock.calls.length).toBeGreaterThan(
      loadsBeforeClick,
    );
  });

  it('saves the edited disclaimer and about copy through the blob save, unaffected by the gates', async () => {
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
    expect(setSiteGate).not.toHaveBeenCalled();
  });
});
