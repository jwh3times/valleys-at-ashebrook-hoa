"use client";

import { useState } from "react";
import type { DuesOption } from "@/lib/site";
import { formatCurrency } from "@/lib/format";

export default function DuesForm({ options }: { options: DuesOption[] }) {
  const [selected, setSelected] = useState(options[0]?.id ?? "");
  const [property, setProperty] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePay() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: selected, property }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok || !json.url) {
        setError(json.error ?? "Unable to start checkout. Please try again.");
        setLoading(false);
        return;
      }
      // Redirect to Stripe Checkout.
      window.location.href = json.url as string;
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      )}

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-foreground">
          Select a payment
        </legend>
        {options.map((opt) => (
          <label
            key={opt.id}
            className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors ${
              selected === opt.id
                ? "border-brand bg-brand-light"
                : "border-border bg-surface hover:border-brand/50"
            }`}
          >
            <input
              type="radio"
              name="duesOption"
              value={opt.id}
              checked={selected === opt.id}
              onChange={() => setSelected(opt.id)}
              className="mt-1 accent-brand"
            />
            <span className="flex-1">
              <span className="flex items-center justify-between">
                <span className="font-bold text-foreground">{opt.label}</span>
                <span className="font-bold text-brand-dark">
                  {formatCurrency(opt.amount)}
                </span>
              </span>
              <span className="mt-0.5 block text-sm text-muted">
                {opt.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="block text-sm font-medium text-foreground">
        Property address or account number{" "}
        <span className="font-normal text-muted">(optional)</span>
        <input
          type="text"
          value={property}
          onChange={(e) => setProperty(e.target.value)}
          maxLength={200}
          placeholder="1 Ashebrook Drive"
          className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-foreground shadow-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
        />
        <span className="mt-1 block text-xs text-muted">
          Helps us match your payment to your account.
        </span>
      </label>

      <button
        type="button"
        onClick={handlePay}
        disabled={loading || !selected}
        className="w-full rounded-md bg-brand px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {loading ? "Redirecting to secure checkout…" : "Continue to Payment"}
      </button>

      <p className="text-xs text-muted">
        Payments are processed securely by Stripe. Your card details are never
        stored on this website.
      </p>
    </div>
  );
}
