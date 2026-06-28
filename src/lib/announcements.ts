import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";

/**
 * Announcements are plain Markdown files stored in `content/announcements/`.
 * Each file begins with a small frontmatter block, for example:
 *
 *   ---
 *   title: Pool Opens Memorial Day Weekend
 *   date: 2026-05-20
 *   author: Recreation Committee
 *   pinned: false
 *   summary: The community pool opens for the season on May 23.
 *   ---
 *
 *   Markdown body goes here...
 *
 * To post a new announcement, add a new `.md` file to that folder. The file
 * name (minus `.md`) becomes the URL slug.
 */

const ANNOUNCEMENTS_DIR = path.join(process.cwd(), "content", "announcements");

export type Announcement = {
  slug: string;
  title: string;
  date: string; // ISO date (YYYY-MM-DD)
  author: string;
  summary: string;
  pinned: boolean;
  /** Rendered HTML body. */
  html: string;
};

function readAll(): Announcement[] {
  if (!fs.existsSync(ANNOUNCEMENTS_DIR)) return [];

  const files = fs
    .readdirSync(ANNOUNCEMENTS_DIR)
    .filter((f) => f.endsWith(".md"));

  const items = files.map((file) => {
    const slug = file.replace(/\.md$/, "");
    const raw = fs.readFileSync(path.join(ANNOUNCEMENTS_DIR, file), "utf8");
    const { data, content } = matter(raw);

    return {
      slug,
      title: String(data.title ?? slug),
      date: String(data.date ?? ""),
      author: String(data.author ?? "HOA Board"),
      summary: String(data.summary ?? ""),
      pinned: Boolean(data.pinned ?? false),
      html: marked.parse(content, { async: false }) as string,
    } satisfies Announcement;
  });

  // Pinned first, then newest by date.
  return items.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.date.localeCompare(a.date);
  });
}

export function getAnnouncements(): Announcement[] {
  return readAll();
}

export function getAnnouncement(slug: string): Announcement | undefined {
  return readAll().find((a) => a.slug === slug);
}
