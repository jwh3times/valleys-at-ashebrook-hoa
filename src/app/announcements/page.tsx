import type { Metadata } from "next";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { getAnnouncements } from "@/lib/announcements";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Announcements",
  description: "News and updates from the HOA board.",
};

export default function AnnouncementsPage() {
  const announcements = getAnnouncements();

  return (
    <div>
      <PageHeader
        title="Announcements"
        subtitle="News, updates, and notices from the board and committees."
      />
      <div className="mx-auto max-w-4xl px-4 py-10">
        {announcements.length === 0 ? (
          <p className="text-muted">No announcements have been posted yet.</p>
        ) : (
          <ul className="space-y-5">
            {announcements.map((a) => (
              <li
                key={a.slug}
                className="rounded-xl border border-border bg-surface p-6 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <time>{formatDate(a.date)}</time>
                  <span aria-hidden>•</span>
                  <span>{a.author}</span>
                  {a.pinned && (
                    <span className="rounded-full bg-accent/15 px-2 py-0.5 font-semibold text-accent">
                      Pinned
                    </span>
                  )}
                </div>
                <h2 className="mt-2 text-xl font-bold text-foreground">
                  <Link
                    href={`/announcements/${a.slug}`}
                    className="hover:text-brand"
                  >
                    {a.title}
                  </Link>
                </h2>
                <p className="mt-2 text-muted">{a.summary}</p>
                <Link
                  href={`/announcements/${a.slug}`}
                  className="mt-4 inline-block text-sm font-semibold text-brand hover:text-brand-dark"
                >
                  Read more →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
