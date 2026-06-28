import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import { getDocumentsByCategory } from "@/lib/documents";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Governing Documents",
  description: "CC&Rs, bylaws, forms, financials, and other community documents.",
};

export default function DocumentsPage() {
  const groups = getDocumentsByCategory();

  return (
    <div>
      <PageHeader
        title="Governing Documents"
        subtitle="Download the association's official documents, forms, and financials."
      />

      <div className="mx-auto max-w-4xl px-4 py-10">
        {groups.length === 0 ? (
          <p className="text-muted">No documents are available yet.</p>
        ) : (
          <div className="space-y-10">
            {groups.map(([category, docs]) => (
              <section key={category}>
                <h2 className="text-xl font-bold text-brand-dark">
                  {category}
                </h2>
                <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
                  {docs.map((doc) => (
                    <li key={doc.file}>
                      <a
                        href={`/documents/${doc.file}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-start gap-4 p-4 transition-colors hover:bg-brand-light"
                      >
                        <span
                          aria-hidden
                          className="mt-0.5 text-2xl text-brand"
                        >
                          📄
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold text-foreground">
                            {doc.title}
                          </span>
                          {doc.description && (
                            <span className="mt-0.5 block text-sm text-muted">
                              {doc.description}
                            </span>
                          )}
                          {doc.updated && (
                            <span className="mt-1 block text-xs text-muted">
                              Updated {formatDate(doc.updated)}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 self-center text-sm font-semibold text-brand">
                          Download →
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
