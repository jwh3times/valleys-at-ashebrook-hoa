/** Whether online dues payment is configured (Stripe secret key present). */
export function isPaymentsConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
