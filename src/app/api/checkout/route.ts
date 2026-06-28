import { NextResponse } from "next/server";
import Stripe from "stripe";
import { z } from "zod";
import { duesOptions, site } from "@/lib/site";

/**
 * Creates a Stripe Checkout session for a dues payment.
 *
 * Requires STRIPE_SECRET_KEY to be set (see .env.example). When it is not set,
 * this route returns 503 and the /dues page shows setup instructions instead of
 * a pay button — so the site runs fine before payments are wired up.
 *
 * The amount is taken from the trusted server-side `duesOptions` list (looked up
 * by id), never from the client, so the charged amount cannot be tampered with.
 */

const CheckoutSchema = z.object({
  optionId: z.string().min(1),
  property: z.string().trim().max(200).optional(),
});

export async function POST(request: Request) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json(
      { error: "Online payments are not configured yet." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = CheckoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const option = duesOptions.find((o) => o.id === parsed.data.optionId);
  if (!option) {
    return NextResponse.json(
      { error: "Unknown dues option." },
      { status: 400 },
    );
  }

  const origin =
    request.headers.get("origin") ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "http://localhost:3000";

  const stripe = new Stripe(secretKey);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(option.amount * 100),
            product_data: {
              name: `${site.shortName} — ${option.label}`,
              description: option.description,
            },
          },
        },
      ],
      metadata: {
        optionId: option.id,
        property: parsed.data.property ?? "",
      },
      success_url: `${origin}/dues/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/dues?canceled=1`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[checkout] Stripe error:", err);
    return NextResponse.json(
      { error: "We couldn't start checkout. Please try again later." },
      { status: 502 },
    );
  }
}
