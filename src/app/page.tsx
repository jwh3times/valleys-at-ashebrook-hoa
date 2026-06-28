import Link from "next/link";
import { site } from "@/lib/site";
import { getAnnouncements } from "@/lib/announcements";
import { getUpcomingEvents } from "@/lib/events";
import { formatDate } from "@/lib/format";

const quickLinks = [
  {
    href: "/announcements",
    title: "Announcements",
    body: "Read the latest news and updates from the board.",
    icon: "📣",
  },
  {
    href: "/calendar",
    title: "Community Calendar",
    body: "See upcoming meetings, events, and important dates.",
    icon: "📅",
  },
  {
    href: "/documents",
    title: "Governing Documents",
    body: "Access CC&Rs, bylaws, forms, and financials.",
    icon: "📄",
  },
  {
    href: "/dues",
    title: "Pay Dues",
    body: "Pay your assessment securely online.",
    icon: "💳",
  },
];

export default function Home() {
  const announcements = getAnnouncements().slice(0, 3);
  const events = getUpcomingEvents().slice(0, 4);

  return (
    <div>
      {/* Hero */}
      <section className="bg-gradient-to-b from-brand-light to-background">
        <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:py-24">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand">
            Welcome to
          </p>
          <h1 className="mt-2 text-4xl font-bold text-brand-dark sm:text-5xl">
            {site.name}
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted">
            {site.tagline}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/announcements"
              className="rounded-md bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-dark"
            >
              Latest News
            </Link>
            <Link
              href="/dues"
              className="rounded-md border border-brand bg-surface px-5 py-2.5 text-sm font-semibold text-brand-dark transition-colors hover:bg-brand-light"
            >
              Pay Dues
            </Link>
          </div>
        </div>
      </section>

      {/* Quick links */}
      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {quickLinks.map((q) => (
            <Link
              key={q.href}
              href={q.href}
              className="group rounded-xl border border-border bg-surface p-5 shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="text-2xl" aria-hidden>
                {q.icon}
              </div>
              <h2 className="mt-3 text-lg font-bold text-brand-dark group-hover:text-brand">
                {q.title}
              </h2>
              <p className="mt-1 text-sm text-muted">{q.body}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Announcements + events */}
      <section className="mx-auto grid max-w-6xl gap-8 px-4 pb-16 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-brand-dark">
              Recent Announcements
            </h2>
            <Link
              href="/announcements"
              className="text-sm font-medium text-brand hover:text-brand-dark"
            >
              View all →
            </Link>
          </div>
          <div className="mt-4 space-y-4">
            {announcements.length === 0 && (
              <p className="text-muted">No announcements yet.</p>
            )}
            {announcements.map((a) => (
              <article
                key={a.slug}
                className="rounded-xl border border-border bg-surface p-5 shadow-sm"
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
                <h3 className="mt-2 text-lg font-bold text-foreground">
                  <Link
                    href={`/announcements/${a.slug}`}
                    className="hover:text-brand"
                  >
                    {a.title}
                  </Link>
                </h3>
                <p className="mt-1 text-sm text-muted">{a.summary}</p>
                <Link
                  href={`/announcements/${a.slug}`}
                  className="mt-3 inline-block text-sm font-medium text-brand hover:text-brand-dark"
                >
                  Read more →
                </Link>
              </article>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-brand-dark">Upcoming</h2>
            <Link
              href="/calendar"
              className="text-sm font-medium text-brand hover:text-brand-dark"
            >
              Calendar →
            </Link>
          </div>
          <div className="mt-4 space-y-3">
            {events.length === 0 && (
              <p className="text-muted">No upcoming events.</p>
            )}
            {events.map((e, i) => (
              <div
                key={`${e.title}-${i}`}
                className="rounded-xl border border-border bg-surface p-4 shadow-sm"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-brand">
                  {formatDate(e.date)}
                </p>
                <p className="mt-1 font-bold text-foreground">{e.title}</p>
                <p className="mt-0.5 text-sm text-muted">
                  {[e.time, e.location].filter(Boolean).join(" · ")}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
