export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.EMAIL_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
  });
  if (!res.ok) throw new Error(`email send failed: ${res.status}`);
}

export async function sendSms(
  env: Env,
  to: string,
  text: string,
): Promise<void> {
  const sid = env.TWILIO_ACCOUNT_SID;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const body = new URLSearchParams({
    To: to,
    From: env.TWILIO_FROM,
    Body: text,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${sid}:${env.TWILIO_AUTH_TOKEN}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`sms send failed: ${res.status}`);
}
