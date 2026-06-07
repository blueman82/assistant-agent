# AGENTS.md — Wiki Schema for assistant-agent

## Wiki location

`/Users/harrison/Github/assistant-agent-wiki/`

## Three layers

1. **Raw sources** — immutable input. Two locations:
   - The project codebase at `/Users/harrison/Github/assistant-agent/` — read via normal file tools
   - Drop zone at `/Users/harrison/Github/assistant-agent-wiki/raw/` — articles, PDFs, notes Gary drops in. Read, never modify.
2. **Wiki** — LLM-maintained markdown at the vault path above. Claude owns this entirely.
3. **Schema** — this file. Defines conventions and workflows.

## Page types

| Directory | Purpose |
|-----------|---------|
| `architecture/` | How the system is built — components, wiring, data flow |
| `capabilities/` | What the secretary can do — one page per tool surface |
| `patterns/` | Reusable approaches — how to extend, configure, evolve |
| `investigations/` | Filed-back answers to Gary's queries |
| `sources/` | Ingested references — docs, gists, PRs |
| `templates/` | Page skeletons — copy, don't edit |

## Page format

```yaml
---
title: ""
type: architecture | capability | pattern | investigation | source
created: YYYY-MM-DD
last_updated: YYYY-MM-DD
sources: []   # file paths or URLs consulted
tags: []
---
```

Body: concise (under 2 min to read). Use `[[wiki-links]]` for cross-references. No narrative — facts and relationships only.

## Workflows

### Ingest (new source added)
Trigger: Gary says "ingest raw/" or "ingest [file]", or a new file appears in `raw/`.
1. `Glob` the `raw/` directory to find unprocessed files
2. For each file: `Read` it in full — never summarise before reading
3. Update 5–15 existing wiki pages that relate to it (add cross-refs, update facts, correct stale claims)
4. Create a new `sources/YYYY-MM-DD-slug.md` page summarising what was learned
5. Append an entry to `log.md`
6. Do NOT delete or modify the raw file — it stays as the immutable source

### Query (Gary asks a question)
1. Read `index.md` first
2. Read relevant pages
3. Answer from wiki; if the answer required non-trivial synthesis, file it back as `investigations/YYYY-MM-DD-slug.md`
4. Update `index.md` if a new investigations page was created

### Lint (periodic maintenance)
- Check for contradictions between pages
- Check for orphaned pages not linked from `index.md`
- Check `last_updated` — flag pages not updated in 90+ days if they cover active code

## Conventions

- `index.md` — read first, always. Update when pages are added.
- `log.md` — append only. Format: `## [YYYY-MM-DD] operation | description`
- Wikilinks use filename without extension: `[[architecture/overview]]`
- "Not yet documented." marks known gaps in `index.md`

## Evolution

This schema evolves with the project. When a new capability or page type is needed, update this file and add the new directory and template.
