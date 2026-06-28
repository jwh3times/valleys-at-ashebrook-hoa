import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import ContactForm from "@/components/ContactForm";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Contact",
  description: `Get in touch with the ${site.name} board.`,
};

export default function ContactPage() {
  return (
    <div>
      <PageHeader
        title="Contact the Board"
        subtitle="Questions, concerns, or suggestions? Send us a message."
      />

      <div className="mx-auto grid max-w-5xl gap-10 px-4 py-10 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ContactForm />
        </div>

        <aside className="space-y-6">
          <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
            <h2 className="text-lg font-bold text-brand-dark">Reach Us</h2>
            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="font-semibold text-foreground">Email</dt>
                <dd>
                  <a
                    className="text-brand hover:text-brand-dark"
                    href={`mailto:${site.email}`}
                  >
                    {site.email}
                  </a>
                </dd>
              </div>
              {site.phone && (
                <div>
                  <dt className="font-semibold text-foreground">Phone</dt>
                  <dd>
                    <a
                      className="text-brand hover:text-brand-dark"
                      href={`tel:${site.phone}`}
                    >
                      {site.phone}
                    </a>
                  </dd>
                </div>
              )}
              <div>
                <dt className="font-semibold text-foreground">Mailing Address</dt>
                <dd className="text-muted">{site.address}</dd>
              </div>
            </dl>
          </div>

          {site.hours && (
            <div className="rounded-xl border border-border bg-brand-light p-5">
              <h2 className="text-lg font-bold text-brand-dark">Meetings</h2>
              <p className="mt-2 text-sm text-brand-dark">{site.hours}</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
