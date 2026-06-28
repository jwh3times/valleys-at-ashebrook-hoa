import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import DuesForm from "@/components/DuesForm";
import { duesOptions, site } from "@/lib/site";
import { isPaymentsConfigured } from "@/lib/payments";

export const metadata: Metadata = {
  title: "Pay Dues",
  description: `Pay your ${site.name} dues securely online.`,
};

export default async function DuesPage({
  searchParams,
}: {
  searchParams: Promise<{ canceled?: string }>;
}) {
  const { canceled } = await searchParams;
  const configured = isPaymentsConfigured();

  return (
    <div>
      <PageHeader
        title="Pay Your Dues"
        subtitle="Pay your association assessment quickly and securely online."
      />

      <div className="mx-auto max-w-2xl px-4 py-10">
        {canceled && (
          <p className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Your payment was canceled. You can try again whenever you&apos;re
            ready.
          </p>
        )}

        {configured ? (
          <DuesForm options={duesOptions} />
        ) : (
          <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">
            <h2 className="text-lg font-bold text-brand-dark">
              Online payments coming soon
            </h2>
            <p className="mt-2 text-muted">
              Online dues payment isn&apos;t set up on this site yet. In the
              meantime, please contact the board to arrange payment:
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              <li>
                Email:{" "}
                <a
                  className="text-brand hover:text-brand-dark"
                  href={`mailto:${site.email}`}
                >
                  {site.email}
                </a>
              </li>
              {site.phone && (
                <li>
                  Phone:{" "}
                  <a
                    className="text-brand hover:text-brand-dark"
                    href={`tel:${site.phone}`}
                  >
                    {site.phone}
                  </a>
                </li>
              )}
            </ul>
            <p className="mt-4 text-xs text-muted">
              Site administrators: add a <code>STRIPE_SECRET_KEY</code> to enable
              online payments. See <code>README.md</code> for setup steps.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
