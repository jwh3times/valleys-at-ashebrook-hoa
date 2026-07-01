import { describe, it, expect, vi } from 'vitest';
import { sendSms, sendEmail } from '../../src/server/auth/senders';

describe('sendSms', () => {
  it('posts to the Twilio API and throws on failure', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('err', { status: 401 }));
    const env = {
      TWILIO_ACCOUNT_SID: 'AC',
      TWILIO_AUTH_TOKEN: 't',
      TWILIO_FROM: '+1',
    } as unknown as Env;
    await expect(sendSms(env, '+15551234567', 'hi')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('sendEmail', () => {
  it('posts to the Resend API and throws on failure', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('err', { status: 401 }));
    const env = {
      EMAIL_API_KEY: 'k',
      EMAIL_FROM: 'from@example.com',
    } as unknown as Env;
    await expect(
      sendEmail(env, 'to@example.com', 'Subject', 'Body'),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
