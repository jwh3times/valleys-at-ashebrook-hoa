import type { Metadata } from "next";
import Link from "next/link";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Payment Received",
  robots: { index: false },
};

export default function DuesSuccessPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-20 text-center">
      <div
        aria-hidden
        className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-light text-3xl"
      >
        ✅
      </div>
      <h1 className="mt-6 text-3xl font-bold text-brand-dark">Thank you!</h1>
      <p className="mt-3 text-muted">
        Your dues payment to {site.name} was received. A receipt has been sent to
        the email address you provided at checkout.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <Link
          href="/"
          className="rounded-md bg-brand px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-dark"
        >
          Back to Home
        </Link>
        <Link
          href="/contact"
          className="rounded-md border border-brand px-5 py-2.5 text-sm font-semibold text-brand-dark transition-colors hover:bg-brand-light"
        >
          Contact the Board
        </Link>
      </div>
    </div>
  );
}
