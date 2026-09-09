export async function verifyTurnstile(
  env: Env,
  token: string,
  request: Request,
): Promise<boolean> {
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
    remoteip: request.headers.get('cf-connecting-ip') ?? '',
  });
  // An unreachable or misbehaving siteverify is an UNVERIFIED token, not a
  // server error: throwing here surfaced as a 500 from callers whose contract
  // is a 400 for a bad captcha, so a Turnstile outage turned every gated form
  // into an error page instead of a retry prompt. Fail closed and let the
  // caller keep its contract.
  try {
    const res = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        body,
      },
    );
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error('[turnstile] siteverify failed:', err);
    return false;
  }
}
