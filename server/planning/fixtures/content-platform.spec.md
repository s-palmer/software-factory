# Spec: regional content platform (CMS, content store, frontend)

> Status: example spec for the planning tests.
> The research system that feeds this platform is **out of scope**; this spec fixes only its input and output contract.

## Problem Statement

We want a website that keeps people up to date with what is happening in one city or region: events coming up, and news. Writing that by hand does not scale, so research agents will find it. Today there is nowhere for their findings to go: no agreed format, no store, no checks between "an agent found something" and "it is on the site", and no site.

The platform must work for any region (a city, a county, a country), chosen by configuration, not by code.

## Solution

A pipeline from structured research to published articles, with a person able to step in at any point but not required to:

1. **Research contract.** Research agents receive a structured **brief** and send back a **batch** of structured **research items** (an event or a news story, each with its sources). Both are versioned schemas with a JSON Schema export, so any agent, in any language, can be checked against them.
2. **Content store.** A content server accepts batches over HTTP, validates them against the contract, drops duplicates, and keeps every item and its sources in DuckDB. It is the only writer of its database.
3. **Editorial checks.** Plain code checks each item: required fields, plausible dates, sources present and reachable, not a duplicate of something already published. An item passes or is rejected with reasons.
4. **CMS.** Items that pass become **draft** entries in EmDash (events and news collections), created and updated through the EmDash API only. Editors can change or stop any of them in the EmDash admin.
5. **Publication cycle.** A calendar of publication slots decides when drafts go live. The content server publishes at the slot time. Nothing rejected is ever published.
6. **Frontend.** An Astro site, rendered from EmDash, with pages for upcoming events, news, and a home page that combines them, in the region's language and time zone.

## User Stories

Readers
1. As a reader, I want a home page that shows the next events and the latest news for my region, so that I can see what is happening at a glance.
2. As a reader, I want event times shown in the region's local time zone, so that I am not confused by UTC.
3. As a reader, I want past events to drop off the upcoming list automatically, so that the site never advertises something that has ended.
4. As a reader, I want each event page to show when, where, the price and how to book, so that I can decide whether to go.
5. As a reader, I want each article to name its sources with links, so that I can check where the information came from.
6. As a reader, I want to browse events and news by category and tag, so that I find what interests me.
7. As a reader, I want pages that load fast and work on a phone, so that I can use the site on the move.
8. As a reader, I want a stable URL for each event and article, so that I can share it.
9. As a reader, I want a clear "updated" note when an article changes after publication, so that I know the information was revised.

Editors
10. As an editor, I want every incoming item to appear as a draft in the EmDash admin, so that I can review it before or after it goes live.
11. As an editor, I want to edit a draft in the admin and have my edit kept, so that the pipeline does not overwrite human changes.
12. As an editor, I want to unpublish an article in the admin and have it stay unpublished, so that I keep the final say.
13. As an editor, I want to see why an item was rejected, so that I can fix the research or publish it myself.
14. As an editor, I want to see the publication calendar and what is scheduled in each slot, so that I know what will go live and when.
15. As an editor, I want to move an item to a different slot or publish it now, so that urgent news is not held back.

Operators
16. As an operator, I want to set the region (name, time zone, language, country) in configuration, so that the same code runs a site for any place.
17. As an operator, I want to set the publication slots per content kind, so that the site has a steady rhythm.
18. As an operator, I want a status command that shows how many items are in each stage and the latest rejections, so that I can see the pipeline is healthy.
19. As an operator, I want the content server to refuse items that do not match the contract, with a precise error per field, so that bad research never enters the store.
20. As an operator, I want every stage change recorded with a time and a reason, so that I can audit how an article got onto the site.
21. As an operator, I want the pipeline to be safe to re-run, so that a crash or a repeated batch never creates duplicate articles.

Research agents (the future system; the contract only)
22. As a research agent, I want a brief that names the region, the topics, the time window and the limits, so that I know exactly what to look for.
23. As a research agent, I want a JSON Schema for my output, so that I can validate my batch before I send it.
24. As a research agent, I want a response that lists, per item, whether it was accepted, a duplicate or invalid (and why), so that I can learn from rejections.
25. As a research agent, I want to resend an updated version of an item I sent before, so that corrections reach the site.

Developers and the factory
26. As a developer, I want sample batches for a demo region, so that I can run the whole pipeline locally without any research agent.
27. As the factory's browser check, I want the site and the content server to start with one command on configurable ports, so that I can verify each change in a real browser.

## Implementation Decisions

Repository and stack
- The platform lives in the factory's project folder as a pnpm workspace with three parts: the **research contract** package, the **content server**, and the **site**. The factory's own code stays where it is.
- TypeScript strict everywhere, zod for schemas, vitest for tests, oxlint for lint (the factory's existing tooling and its gate).
- The site is an EmDash site from the Node.js starter (Astro, server rendered, SQLite as EmDash's own database). The content server is Hono on Node with DuckDB, following the factory server's patterns (one writer, a statement queue, migrations in place).
- All ports come from configuration.

Region
- One deployment serves one region. Region configuration: `slug`, `name`, `timeZone` (IANA), `locale` (BCP 47), `country` (ISO 3166-1 alpha-2), optional bounding box. The site, the editorial checks and the research brief all read the same configuration. The demo region in fixtures is configurable; nothing in code names a place.

Research contract (versioned, `schemaVersion: 1`)
- **ResearchBrief** (input to research): `briefId`, `region` (the region configuration), `kinds` (subset of `event`, `news`), `topics` (free tags, e.g. "music", "transport"), `window` (`from`, `to`, ISO 8601 with offset), `maxItems`, `language`, optional `excludeUrls` (already known canonical URLs), `issuedAt`.
- **ResearchItem** (output), common fields: `schemaVersion`, `externalId` (stable per item from the agent's point of view, used for resends), `kind`, `title` (≤ 140 chars), `summary` (≤ 300 chars), `body` (Markdown, the article text), `regionSlug`, `categories`, `tags`, `sources` (at least one), optional `images`, `confidence` (0 to 1), `researchedAt`, `agent` (`name`, `model`, optional `runId`).
  - `kind: "event"` adds `event`: `startsAt`, optional `endsAt` (ISO 8601 with offset), `allDay`, `venue` (`name`, optional `address`, optional `lat`/`lng`), optional `price` (`free` or `{ min, max, currency }`), optional `bookingUrl`, optional `organiser`.
  - `kind: "news"` adds `news`: `happenedAt` (or the publication time of the main source), optional `location`, optional `people`/`organisations` mentioned.
  - **Source**: `url`, `title`, `publisher`, `retrievedAt`, `excerpt` (the quoted text that supports the item, ≤ 500 chars).
  - **Image**: `url`, `alt`, `credit`, `licence`.
- **ResearchBatch**: `schemaVersion`, `briefId`, `items`.
- **Ingest response**: per item, `externalId` and one of `accepted` (new or updated), `duplicate` (with the matching item id) or `invalid` (with field paths and messages).
- The contract package exports the zod schemas, TypeScript types and a generated JSON Schema file. The JSON Schema is checked into the repository and a test fails if it is out of date.

Content store (DuckDB, owned by the content server)
- Tables: `briefs`, `items` (validated columns plus the raw JSON), `sources`, `item_events` (add-only audit log: stage changes with time, actor and reason), `publications` (the link to the EmDash entry: collection, id, last `_rev`, state, slot), `settings`.
- **Dedupe key**: for events, normalised title plus start date plus venue name; for news, the canonical URL of the first source. A resend with the same `externalId` updates the item instead of creating a new one. A different `externalId` with the same dedupe key is a duplicate.

Content lifecycle (a pure module, like the factory's)
- Stages: `received` → `checked` → `staged` (draft in EmDash) → `scheduled` → `published`; off the line: `rejected` (with reasons), `withdrawn` (an editor unpublished it, or a past event was archived).
- Editorial checks (deterministic, no model): required fields present; event `startsAt` inside the brief window and not in the past; `endsAt` after `startsAt`; every source URL answers with HTTP 2xx or 3xx (through a fetch interface that tests fake); item not a duplicate of a published one; text within length limits.
- An item updated by a resend goes back through the checks; if it is already published, the EmDash entry is updated and marked as updated.

CMS (EmDash)
- Collections: `events` and `news`, with fields that mirror the contract (venue, dates, price and booking link for events; sources as a repeater on both; categories and tags as taxonomies).
- The content server writes to EmDash only through its REST API, with an Editor-role API token from configuration, and always creates **drafts** (the CLI and API publish immediately unless told otherwise).
- **Human edits win.** The publisher stores the `_rev` it last wrote. If the entry's current `_rev` differs, a person edited it, and the publisher does not overwrite it; it records the conflict. An entry an editor unpublished stays unpublished.

Publication cycle
- Slots per kind in configuration, in the region's time zone (for example news: 08:00, 12:00, 17:00; events: as soon as checked, but not later than a set number of days before the start).
- The content server publishes at the slot time itself (EmDash's scheduler is not relied on). It mirrors the schedule into EmDash so editors see it in the admin.
- Past events are archived automatically after `endsAt` (or the end of the day for all-day events).

Interfaces
- Content server HTTP API (127.0.0.1 only): submit a batch, get an item with its history, list items by stage, get the calendar, publish now, move to a slot. Errors are `{ "error": ... }`; every input is validated.
- A `content` CLI wraps the API with `--json` output and the factory CLI's exit codes, for operators and future agents.

## Testing Decisions

- Test behaviour at the highest seam: the contract through its exported parse functions; the content server through its HTTP API in process with an in-memory DuckDB (the factory's API tests are prior art); the lifecycle as pure functions (prior art: the factory's lifecycle tests); EmDash through a fake implementing the same publisher interface, plus one integration test against a real local EmDash.
- Source URL checks and the clock go through interfaces, so tests never touch the network or depend on today's date.
- The site: page tests render with fixture content and assert what a reader sees (event time in the region's time zone, sources listed, past events absent). The factory's browser check verifies acceptance criteria in a real browser.
- Fixtures: a set of valid batches for a demo region, plus invalid ones that must fail with specific errors. A test checks the committed JSON Schema matches the zod schemas.
- One end-to-end test runs fixtures through ingest, checks, drafts, a slot, and publication, then reads the published page.

## Out of Scope

- The research agents themselves (finding events and news). Only the brief and batch contract is in scope.
- Deployment to a public host and its configuration (decided after the local review).
- Several regions in one deployment.
- User accounts for readers, comments, newsletters, search beyond EmDash's built-in search.
- Images beyond storing the URL, alt text, credit and licence (no download or resizing).
- Translation between languages.

## Further Notes

- EmDash's CLI and API publish immediately unless told to make a draft; every write from the content server must request a draft.
- The first EmDash admin user is created through a passkey in the browser, so a person sets up the admin once. Agents never create credentials; the API token is created by a person and given through configuration.
- Adding packages changes `package.json` and the lockfile, which the factory's risk policy marks high risk, so those pull requests are merged by a person.
