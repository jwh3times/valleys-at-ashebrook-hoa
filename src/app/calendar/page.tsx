import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import { getEvents, type CommunityEvent } from "@/lib/events";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Community Calendar",
  description: "Upcoming meetings, events, and important community dates.",
};

function monthKey(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function groupByMonth(events: CommunityEvent[]): [string, CommunityEvent[]][] {
  const groups = new Map<string, CommunityEvent[]>();
  for (const e of events) {
    const key = monthKey(e.date);
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  return [...groups.entries()];
}

export default function CalendarPage() {
  const today = new Date().toISOString().slice(0, 10);
  const all = getEvents();
  const upcoming = all.filter((e) => e.date >= today);
  const past = all.filter((e) => e.date < today).reverse();

  return (
    <div>
      <PageHeader
        title="Community Calendar"
        subtitle="Mark your calendar for upcoming meetings and neighborhood events."
      />

      <div className="mx-auto max-w-4xl px-4 py-10">
        <h2 className="text-2xl font-bold text-brand-dark">Upcoming Events</h2>
        {upcoming.length === 0 ? (
          <p className="mt-3 text-muted">No upcoming events scheduled.</p>
        ) : (
          <div className="mt-5 space-y-8">
            {groupByMonth(upcoming).map(([month, events]) => (
              <section key={month}>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-brand">
                  {month}
                </h3>
                <ul className="mt-3 space-y-3">
                  {events.map((e, i) => (
                    <EventRow key={`${e.title}-${i}`} event={e} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {past.length > 0 && (
          <details className="mt-12 group">
            <summary className="cursor-pointer text-lg font-bold text-muted hover:text-brand-dark">
              Past Events ({past.length})
            </summary>
            <ul className="mt-4 space-y-3 opacity-80">
              {past.map((e, i) => (
                <EventRow key={`${e.title}-${i}`} event={e} />
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: CommunityEvent }) {
  return (
    <li className="flex gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm">
      <div className="flex w-16 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-light px-2 py-2 text-center">
        <span className="text-xs font-semibold uppercase text-brand">
          {new Date(`${event.date}T12:00:00Z`).toLocaleDateString("en-US", {
            month: "short",
            timeZone: "UTC",
          })}
        </span>
        <span className="text-xl font-bold text-brand-dark">
          {new Date(`${event.date}T12:00:00Z`).getUTCDate()}
        </span>
      </div>
      <div className="min-w-0">
        <p className="font-bold text-foreground">{event.title}</p>
        <p className="mt-0.5 text-sm text-muted">
          {[formatDate(event.date), event.time, event.location]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {event.description && (
          <p className="mt-1 text-sm text-muted">{event.description}</p>
        )}
      </div>
    </li>
  );
}
