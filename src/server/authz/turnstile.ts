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
  const res = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      body,
    },
  );
  const data = (await res.json()) as { success: boolean };
  return data.success;
}
