"use client";

import { useState } from "react";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

const inputClass =
  "mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-foreground shadow-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/30";

export default function ContactForm() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus({ kind: "submitting" });

    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        setStatus({
          kind: "error",
          message: json.error ?? "Something went wrong. Please try again.",
        });
        return;
      }
      form.reset();
      setStatus({ kind: "success" });
    } catch {
      setStatus({
        kind: "error",
        message: "Network error. Please try again.",
      });
    }
  }

  if (status.kind === "success") {
    return (
      <div
        role="status"
        className="rounded-xl border border-brand bg-brand-light p-6 text-brand-dark"
      >
        <p className="text-lg font-bold">Thank you! 🎉</p>
        <p className="mt-1 text-sm">
          Your message has been sent to the board. We&apos;ll get back to you as
          soon as we can.
        </p>
        <button
          type="button"
          onClick={() => setStatus({ kind: "idle" })}
          className="mt-4 text-sm font-semibold underline"
        >
          Send another message
        </button>
      </div>
    );
  }

  const submitting = status.kind === "submitting";

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {status.kind === "error" && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {status.message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium text-foreground">
          Name
          <input
            name="name"
            type="text"
            required
            maxLength={100}
            autoComplete="name"
            className={inputClass}
          />
        </label>
        <label className="block text-sm font-medium text-foreground">
          Email
          <input
            name="email"
            type="email"
            required
            maxLength={200}
            autoComplete="email"
            className={inputClass}
          />
        </label>
      </div>

      <label className="block text-sm font-medium text-foreground">
        Subject
        <input
          name="subject"
          type="text"
          required
          maxLength={150}
          className={inputClass}
        />
      </label>

      <label className="block text-sm font-medium text-foreground">
        Message
        <textarea
          name="message"
          required
          maxLength={5000}
          rows={6}
          className={inputClass}
        />
      </label>

      {/* Honeypot: hidden from real users, tempting to bots. */}
      <div className="hidden" aria-hidden>
        <label>
          Company
          <input name="company" type="text" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? "Sending…" : "Send Message"}
      </button>
    </form>
  );
}
