import { NextResponse } from "next/server";
import { z } from "zod";
import { site } from "@/lib/site";

/**
 * Contact form handler.
 *
 * Email delivery uses Resend (https://resend.com) when configured via env vars:
 *   - RESEND_API_KEY   : your Resend API key
 *   - CONTACT_TO_EMAIL : where messages are delivered (defaults to site.email)
 *   - CONTACT_FROM_EMAIL: a verified Resend sender (defaults to onboarding@resend.dev)
 *
 * When RESEND_API_KEY is not set (e.g. local development), the message is logged
 * to the server console instead of being emailed, and the form still reports
 * success so it can be exercised end-to-end.
 */

const ContactSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(100),
  email: z.string().trim().email("A valid email is required.").max(200),
  subject: z.string().trim().min(1, "Subject is required.").max(150),
  message: z.string().trim().min(1, "Message is required.").max(5000),
  // Honeypot field — must be empty. Bots tend to fill every input.
  company: z.string().optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = ContactSchema.safeParse(body);
  if (!parsed.success) {
    const message =
      parsed.error.issues[0]?.message ?? "Please check your input.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const { name, email, subject, message, company } = parsed.data;

  // Honeypot triggered — silently accept without sending.
  if (company && company.trim() !== "") {
    return NextResponse.json({ ok: true });
  }

  const to = process.env.CONTACT_TO_EMAIL || site.email;
  const from = process.env.CONTACT_FROM_EMAIL || "onboarding@resend.dev";
  const apiKey = process.env.RESEND_API_KEY;

  const text = [
    `New message from the ${site.name} website contact form:`,
    "",
    `Name:    ${name}`,
    `Email:   ${email}`,
    `Subject: ${subject}`,
    "",
    message,
  ].join("\n");

  if (!apiKey) {
    // No provider configured — log and succeed so the flow is testable locally.
    console.info("[contact] (email not configured) message received:\n", text);
    return NextResponse.json({ ok: true });
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${site.shortName} Website <${from}>`,
        to: [to],
        reply_to: email,
        subject: `[Contact] ${subject}`,
        text,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("[contact] Resend error:", res.status, detail);
      return NextResponse.json(
        { error: "We couldn't send your message. Please try again later." },
        { status: 502 },
      );
    }
  } catch (err) {
    console.error("[contact] send failed:", err);
    return NextResponse.json(
      { error: "We couldn't send your message. Please try again later." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
