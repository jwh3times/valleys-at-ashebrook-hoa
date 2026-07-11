# -*- coding: utf-8 -*-
import os, re, csv, json

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
HOA = os.path.join(ROOT, "private", "HOA_files")
CORPUS = os.path.join(ROOT, "private", "rag_corpus")
INDEX = os.path.join(CORPUS, "corpus_index.csv")

DISPLAY = {
    "01-governing-documents": "Governing Documents", "02-policies": "Policies",
    "03-forms": "Forms", "04-faqs-howto": "FAQs & How-To", "05-budgets": "Budgets",
    "06-financial-reports": "Financial Reports", "07-bank-and-payments": "Bank & Payments",
    "08-taxes": "Taxes", "09-contracts": "Contracts", "10-insurance": "Insurance",
    "11-meetings": "Meetings", "12-member-correspondence": "Member Correspondence",
    "13-legal-collections": "Legal & Collections", "14-maps-deeds": "Maps & Deeds",
    "15-maintenance-work-orders": "Maintenance & Work Orders", "16-rosters-contacts": "Rosters & Contacts",
}
DEFAULT = {
    "01-governing-documents": "public", "02-policies": "homeowner", "03-forms": "homeowner",
    "04-faqs-howto": "homeowner", "05-budgets": "homeowner", "06-financial-reports": "board",
    "07-bank-and-payments": "board", "08-taxes": "board", "09-contracts": "board",
    "10-insurance": "homeowner", "11-meetings": "homeowner", "12-member-correspondence": "board",
    "13-legal-collections": "board", "14-maps-deeds": "homeowner", "15-maintenance-work-orders": "board",
    "16-rosters-contacts": "board",
}
# files dropped from the human library entirely (foreign + empties)
DROP = {
    "Historical/9-Maintenance and Work Requests/Invoices/2022 Invoices/SKonicaMino22031609250-3.pdf",
    "Historical/1-Maps/Directions.doc",
    "Historical/Forms/template.dotx",
}

def visibility(slug, src):
    p = src.lower()
    if slug == "02-policies" and re.search(r"board member toolbox|management summary|onboarding", p): return "board"
    if slug == "10-insurance" and "quote" in p: return "board"
    if slug == "11-meetings" and re.search(r"sign ?in|sign-in", p): return "board"
    if slug == "14-maps-deeds" and "/deeds/lot" in p: return "board"
    if slug == "16-rosters-contacts" and re.search(r"board member list|service provider", p): return "homeowner"
    return DEFAULT[slug]

# 1) indexed docs: read corpus_index.csv (source -> title, category slug, rag new_path)
by_source = {}
with open(INDEX, encoding="utf-8") as fh:
    for row in csv.DictReader(fh):
        slug = row["category"]
        by_source[row["source"]] = {
            "relativePath": row["source"],
            "title": row["title"],
            "category": DISPLAY[slug],
            "visibility": visibility(slug, row["source"]),
            "ragRelPath": row["new_path"],
        }

# 2) walk HOA_Files; add the 15 unindexed human files not in the index
entries = []
seen = set()
for dirpath, _, names in os.walk(HOA):
    for n in names:
        rel = os.path.relpath(os.path.join(dirpath, n), HOA).replace("\\", "/")
        if rel in DROP:
            continue
        if rel in by_source:
            entries.append(by_source[rel]); seen.add(rel); continue
        # unindexed: preliminary financials or the 2007 covenant rtf twin
        if "Financials-Prelims/" in rel:
            m = re.search(r"/(20\d\d)/(\d\d)/", "/" + rel)
            ym = f"{m.group(1)}-{m.group(2)}" if m else "Preliminary"
            entries.append({"relativePath": rel, "title": f"{ym} Preliminary Financial Report",
                            "category": "Financial Reports", "visibility": "board", "ragRelPath": None})
        elif rel.endswith("Ashebrooke 2007.rtf"):
            entries.append({"relativePath": rel, "title": "2007 Declaration of Covenants (Re-Recorded)",
                            "category": "Governing Documents", "visibility": "public", "ragRelPath": None})
        else:
            raise SystemExit(f"Unclassified human file (add a rule): {rel}")

entries.sort(key=lambda e: e["relativePath"])
out = os.path.join(CORPUS, "import-manifest.json")
json.dump(entries, open(out, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
indexed = sum(1 for e in entries if e["ragRelPath"])
print(f"Wrote {len(entries)} entries ({indexed} indexed, {len(entries)-indexed} download-only) -> {out}")
assert len(entries) == 444, f"expected 444 human files, got {len(entries)}"
assert indexed == 429, f"expected 429 indexed, got {indexed}"
