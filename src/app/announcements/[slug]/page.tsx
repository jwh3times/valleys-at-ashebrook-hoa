import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAnnouncement, getAnnouncements } from "@/lib/announcements";
import { formatDate } from "@/lib/format";

export function generateStaticParams() {
  return getAnnouncements().map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const a = getAnnouncement(slug);
  if (!a) return { title: "Announcement" };
  return { title: a.title, description: a.summary };
}

export default async function AnnouncementPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const announcement = getAnnouncement(slug);
  if (!announcement) notFound();

  return (
    <article className="mx-auto max-w-3xl px-4 py-10">
      <Link
        href="/announcements"
        className="text-sm font-medium text-brand hover:text-brand-dark"
      >
        ← All announcements
      </Link>

      <header className="mt-4 border-b border-border pb-6">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <time>{formatDate(announcement.date)}</time>
          <span aria-hidden>•</span>
          <span>{announcement.author}</span>
          {announcement.pinned && (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent">
              Pinned
            </span>
          )}
        </div>
        <h1 className="mt-3 text-3xl font-bold text-brand-dark">
          {announcement.title}
        </h1>
      </header>

      <div
        className="prose-hoa mt-6 text-foreground"
        dangerouslySetInnerHTML={{ __html: announcement.html }}
      />
    </article>
  );
}
