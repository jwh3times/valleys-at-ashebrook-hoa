import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PayDuesForm from './PayDuesForm';
import * as member from '../../lib/member';

vi.mock('../../lib/member');
const mocked = vi.mocked(member);

const realLocation = window.location;
const assign = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign },
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: realLocation,
  });
});

const amountField = () =>
  screen.getByLabelText('Amount to pay: 1 Example Lane');
const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: /continue to payment/i }));
const typeAmount = (value: string) =>
  fireEvent.change(amountField(), { target: { value } });

describe('PayDuesForm', () => {
  it('offers the balance owed by default', () => {
    render(
      <PayDuesForm
        lotId="lot-1"
        address="1 Example Lane"
        balanceCents={45075}
      />,
    );
    expect(amountField()).toHaveValue('450.75');
  });

  it('starts empty when nothing is owed', () => {
    render(
      <PayDuesForm
        lotId="lot-1"
        address="1 Example Lane"
        balanceCents={-1200}
      />,
    );
    expect(amountField()).toHaveValue('');
  });

  it('sends the typed amount in cents, then goes to the payment page', async () => {
    mocked.startDuesPayment.mockResolvedValue('https://checkout.example/s/1');
    render(
      <PayDuesForm
        lotId="lot-1"
        address="1 Example Lane"
        balanceCents={45075}
      />,
    );

    typeAmount('1,200.50');
    submit();

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://checkout.example/s/1'),
    );
    expect(mocked.startDuesPayment).toHaveBeenCalledWith('lot-1', 120050);
  });

  it.each([
    ['blank', '', 'Enter an amount'],
    ['zero', '0', 'at least $1.00'],
    ['more than the ledger could hold', '2,000,000', 'at most $10,000.00'],
    ['a third decimal place', '12.345', 'no more than two decimal places'],
    ['less than a dollar', '0.99', 'at least $1.00'],
    ['more than one payment may carry', '10000.01', 'at most $10,000.00'],
    ['a negative amount', '-5', 'at least $1.00'],
  ])(
    'refuses %s with a clear message, sending nothing',
    (_, typed, message) => {
      render(
        <PayDuesForm
          lotId="lot-1"
          address="1 Example Lane"
          balanceCents={45075}
        />,
      );

      typeAmount(typed);
      submit();

      expect(screen.getByRole('alert')).toHaveTextContent(message);
      expect(mocked.startDuesPayment).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it('shows the server’s refusal and stays on the page', async () => {
    mocked.startDuesPayment.mockRejectedValue(
      new Error(
        'Online payments were turned off just now. Nothing was charged.',
      ),
    );
    render(
      <PayDuesForm
        lotId="lot-1"
        address="1 Example Lane"
        balanceCents={45075}
      />,
    );

    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'turned off just now',
    );
    expect(assign).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: /continue to payment/i }),
    ).toBeEnabled();
  });

  it('cannot be sent twice while the first request is out', async () => {
    let finish: (url: string) => void = () => {};
    mocked.startDuesPayment.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    render(
      <PayDuesForm
        lotId="lot-1"
        address="1 Example Lane"
        balanceCents={45075}
      />,
    );

    submit();
    expect(
      screen.getByRole('button', { name: /continue to payment/i }),
    ).toBeDisabled();
    submit();
    finish('https://checkout.example/s/1');

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(mocked.startDuesPayment).toHaveBeenCalledTimes(1);
  });

  it('names its Lot on each control, since a page repeats it per Lot', () => {
    render(
      <>
        <PayDuesForm
          lotId="lot-1"
          address="1 Example Lane"
          balanceCents={100}
        />
        <PayDuesForm
          lotId="lot-2"
          address="2 Example Lane"
          balanceCents={100}
        />
      </>,
    );
    expect(
      screen.getByRole('button', {
        name: 'Continue to payment: 2 Example Lane',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Amount to pay: 2 Example Lane'),
    ).toBeInTheDocument();
  });

  it('never presents the payment as settling a particular charge', () => {
    render(
      <PayDuesForm
        lotId="lot-1"
        address="1 Example Lane"
        balanceCents={45075}
      />,
    );
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/assessment|invoice|pays your|for (the )?month/i);
    expect(text).toMatch(/balance/i);
  });
});
