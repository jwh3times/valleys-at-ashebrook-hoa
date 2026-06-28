import Link from "next/link";
import { nav, site } from "@/lib/site";

export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-16 border-t border-border bg-surface">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 md:grid-cols-3">
        <div>
          <h3 className="text-base font-bold text-brand-dark">{site.name}</h3>
          <p className="mt-2 text-sm text-muted">{site.address}</p>
          {site.hours && (
            <p className="mt-2 text-sm text-muted">{site.hours}</p>
          )}
        </div>

        <div>
          <h3 className="text-base font-bold text-brand-dark">Quick Links</h3>
          <ul className="mt-2 space-y-1">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="text-sm text-muted hover:text-brand-dark"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="text-base font-bold text-brand-dark">Contact</h3>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            <li>
              <a className="hover:text-brand-dark" href={`mailto:${site.email}`}>
                {site.email}
              </a>
            </li>
            {site.phone && (
              <li>
                <a className="hover:text-brand-dark" href={`tel:${site.phone}`}>
                  {site.phone}
                </a>
              </li>
            )}
          </ul>
        </div>
      </div>

      <div className="border-t border-border">
        <p className="mx-auto max-w-6xl px-4 py-4 text-center text-xs text-muted">
          © {year} {site.name}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
