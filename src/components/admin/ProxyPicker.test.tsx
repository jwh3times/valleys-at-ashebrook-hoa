import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProxyPicker, { proxiesForOccasion } from './ProxyPicker';
import type { ProxyDetail } from '../../lib/types';

function proxy(overrides: Partial<ProxyDetail> = {}): ProxyDetail {
  return {
    id: 'px1',
    propertyId: 'p1',
    address: '100 Main St',
    grantorOwnerId: 'o1',
    grantorName: 'Jane Doe',
    holderName: 'Alice Holder',
    holderOwnerId: null,
    holderOwnerName: null,
    meetingId: 'm1',
    electionId: null,
    ...overrides,
  };
}

describe('proxiesForOccasion', () => {
  it('scopes meeting occasions to the lot and that meeting', () => {
    const list = [
      proxy(),
      proxy({ id: 'px2', meetingId: 'm2' }),
      proxy({ id: 'px3', propertyId: 'p2' }),
      proxy({ id: 'px4', meetingId: null, electionId: 'e1' }),
    ];
    const out = proxiesForOccasion(list, 'p1', {
      kind: 'meeting',
      meetingId: 'm1',
    });
    expect(out.map((px) => px.id)).toEqual(['px1']);
  });

  it('election occasions accept the election itself and its meeting (ADR 0018 widening)', () => {
    const list = [
      proxy({ id: 'pxE', meetingId: null, electionId: 'e1' }),
      proxy({ id: 'pxM', meetingId: 'm1' }),
      proxy({ id: 'pxOther', meetingId: 'm2' }),
    ];
    const out = proxiesForOccasion(list, 'p1', {
      kind: 'election',
      electionId: 'e1',
      meetingId: 'm1',
    });
    expect(out.map((px) => px.id)).toEqual(['pxE', 'pxM']);
  });

  it('a standalone election accepts only its own proxies', () => {
    const list = [proxy({ id: 'pxM', meetingId: 'm1' })];
    const out = proxiesForOccasion(list, 'p1', {
      kind: 'election',
      electionId: 'e1',
      meetingId: null,
    });
    expect(out).toEqual([]);
  });
});

describe('ProxyPicker', () => {
  it('renders nothing when the lot has no proxies for the occasion', () => {
    const { container } = render(
      <ProxyPicker
        id="pick-1"
        address="100 Main St"
        lotProxies={[]}
        value=""
        onChange={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the no-proxy option plus one option per proxy and reports changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProxyPicker
        id="pick-1"
        address="100 Main St"
        lotProxies={[proxy()]}
        value=""
        onChange={onChange}
      />,
    );
    const select = screen.getByLabelText('Proxy — 100 Main St');
    expect(
      screen.getByRole('option', { name: '— no proxy —' }),
    ).toBeInTheDocument();
    await user.selectOptions(select, 'px1');
    expect(onChange).toHaveBeenCalledWith('px1');
  });

  it('clearing back to no proxy reports an empty string', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProxyPicker
        id="pick-1"
        address="100 Main St"
        lotProxies={[proxy()]}
        value="px1"
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Proxy — 100 Main St'), '');
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('bare mode renders label and select without a wrapper div', () => {
    const { container } = render(
      <ProxyPicker
        id="pick-1"
        address="100 Main St"
        lotProxies={[proxy()]}
        value=""
        onChange={() => {}}
        bare
      />,
    );
    expect(container.querySelector('div')).toBeNull();
    expect(screen.getByLabelText('Proxy — 100 Main St')).toBeInTheDocument();
  });
});
