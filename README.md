# flashcard-mcp

A spaced-repetition flashcard system with an MCP server, an app server and an admin CLI, built on TypeScript, Prisma/SQLite, and FSRS scheduling.

## Features

- **FSRS scheduling** — state-of-the-art spaced repetition via `ts-fsrs` (FSRS-6, with Anki's learning steps and weights mirrored by anki-sync)
- **MCP server** — 32 tools for sessions, cards, code cards, decks, stats, pressure, calibration, leech enforcement, card notes, and duplicate detection over stdio
- **App server** — JSON lines over stdio for Omvida and for the study repo's scripts and wiki-viewer, through the deck SDK (`src/sdk/`)
- **CLI** — admin only: `overview`, `easy-days`, `db:dump`, `db:restore`
- **Semantic duplicate detection** — two-stage Jaccard + cosine similarity on 384-dim embeddings
- **Anki sync** — cards reach AnkiWeb through the study repo's `anki-sync`, which writes this deck only through the app server's `syncApply`
- **Categories** — tag cards with a free-form category and filter sessions/lists accordingly
- **Code cards** — a card answered by running it, after Execute Program: a real Ruby compares values, under bubblewrap, so both need to be installed for them to run (`create_code_card`, `check_code_card`, `run_code_card`)
- **Anti-overload** — caps new cards at 5 and reviews at 15 per session (the `Config` row's defaults); card creation requires explicit approval

## Setup

```bash
npm install             # the SQLite database itself is created/updated by every start
npx prisma generate     # generate Prisma client
```

## CLI

Admin commands only. Studying and card work go through the MCP server and the app server.

```bash
npm run dev:cli -- overview [--pending N]     # pending cards + progress picture, as JSON (the Omvida bar reads it)
npm run dev:cli -- easy-days [--apply]        # move scheduled reviews off Easy Days' reduced days (dry run without --apply)
npm run dev:cli -- db:dump <file>             # portable SQL dump
npm run dev:cli -- db:restore <file> [--force]
```

After `npm run build`, the CLI is available as the `master` binary.

## App server (Omvida)

`npm run dev:app` (`src/app/server.ts`) is what the [Omvida](../omvida) desktop app talks to: JSON lines over stdio, one long-lived process per app. It exposes the study loop (`startSession`, `nextCard`, `grade`, `review`, `skip`, `endSession`, `resolveLeech`), the deck for browsing and editing (`cards`, `searchCards`, `recentlyStudied`, `deleteCard`), card notes (`notes`, `setNote`), recent sessions with the cards each lapsed and noted (`sessions`), `overview`, and `stamp`, a token in three parts that move whenever any process edits a card, reviews one, or writes a note, which the app polls to notice a card fixed in Claude Code. A review keeps the card's `updatedAt`, so the cards part means content edits only. `grade` asks the Claude API (Haiku; the key in `ANTHROPIC_API_KEY`) for a suggested rating with a one-sentence reason (`src/core/grading.ts`); the developer accepts or overrides it before anything is written. `master overview` prints the same overview as JSON for the Omvida bar widget.

Callers that are not Omvida use plain-data methods on the same server, so nothing outside this repo opens `prisma/master.db`: `cardRecords {ids?, inheritedFrom?, includeSuspended?}`, `reviewRecords {cardIds?}`, `tombstones`, `calibration` (what `check_calibration` returns), `deckOverview`, and `syncApply {schedules?, reviews?, imports?, deletions?, schedulerOptions?}`, which applies an anki-sync plan in one transaction. Datetimes are ISO-8601 UTC strings. All three adapters (MCP, app, CLI) call the core through `src/sdk/index.ts`.

## MCP server

```bash
npm run dev:mcp    # stdio transport — connect from Claude Code or any MCP client
```

Example Claude Code configuration:

```json
{
  "mcpServers": {
    "flashcard-mcp": {
      "command": "npx",
      "args": ["tsx", "/path/to/flashcard-mcp/src/mcp/server.ts"]
    }
  }
}
```

### Tools exposed

Sessions: `start_session`, `get_next_card`, `submit_review`, `skip_card`, `adjust_session`, `end_session`, `resolve_leech`
Cards: `create_card`, `get_card`, `update_card`, `delete_card`, `delete_cards`, `list_cards`, `search_cards`, `suspend_card`, `unsuspend_card`, `find_similar_cards`, `get_due_cards`
Card notes: `list_card_notes`, `resolve_card_note`
Decks & stats: `list_decks`, `get_deck_stats`, `delete_deck`, `get_stats`, `check_pressure`, `check_calibration`, `get_session_history`

`check_pressure` is the single source of truth for due counts and the SRS pressure verdict (`ok`/`warn`/`pause`) across two axes: review backlog (due cards excluding state New) and cards added today. `create_card` is blocked while it reads pause; `inheritFrom` splits and `update_card` are always allowed, and splits are excluded from the intake axis via the `Card.inheritedFrom` column. The reported `clearance` covers the flashcards axis only, since reviewing cannot lower intake — only the start of the next day resets it. `newAvailable` is the whole unsuspended New-card pool a session draws from.

`check_calibration` answers whether the questions are at the right difficulty: true retention over the last 30 days (Anki's convention — reviews with `elapsedDays >= 1`, first review per card per **local** calendar day, rated 3 or better) against an 80-90% band, plus a `low-signal` verdict when there are fewer than 50 eligible reviews or more than 80% of ratings are Good. The app server's `calibration` method returns the same report.

Schema changes need no step: every start of the CLI, the MCP server and the app server pushes `prisma/schema.prisma` to the database when it changed (backing the file up first), and refuses a change that would lose data.

Card notes are what the developer noted about a card mid-study in Omvida (Ctrl+N), so the session goes on: an edit to make, or something to understand better. One per card, markdown, in the `CardNote` table and deleted with its card. A fix session started from the app reads them with `list_card_notes` and calls `resolve_card_note` once a note is handled.

Leeches are enforced rather than listed. When `get_next_card` serves a card with 5+ lapses it stamps `Card.leechFlaggedAt` and returns a `leech` field; the next call errors until the card is rewritten (`update_card`, which also clears the flag and resets the lapse count), split (`create_card` with `inheritFrom`, then `delete_card`), deleted, or kept as-is with `resolve_leech(action: "defer")`. A deferred card is recorded in `Card.leechDeferredLapses` and flags again the next time it lapses.

DB dump/restore are CLI-only; the MCP server handles in-memory card operations only. Card import and export (`.apkg`, `.txt`) were removed: Anki sync replaced them.

## Anki interop

### AnkiWeb sync (external)

Live sync to AnkiWeb (for reviewing on the phone) is handled by [`scripts/anki-sync` in the study repo](../study), not by this codebase. It reads the deck and writes its plan through the app server (`cardRecords`, `reviewRecords`, `tombstones`, `syncApply`) and talks to AnkiWeb through a headless Anki bridge collection (fastanki / official `anki` Python package). The contract:

- **One-way card push** — this repo owns card existence and content; the Anki note `guid` is the card's full CUID.
- **Bidirectional scheduling** — the side with the newer last review wins its whole FSRS block; on a tie, a different due date is master's (a due moved without a review, e.g. `master easy-days --apply`); `stability`/`difficulty` map natively to Anki's `memory_state`, no SM-2 conversion.
- **Append-only review history** — revlog and the `Review` table are unioned by (card, timestamp).

Implications for this codebase: keep card CUIDs stable. The sync writes only through `syncApply` (scheduling fields, appended `Review` rows, imports, deletions, scheduler options), so the deck's own rules hold for it. Every delete writes a `DeletedCard` tombstone the sync reads. Datetimes that older versions wrote as epoch-ms are normalized to ISO text on every start.

## Development

```bash
npm test              # vitest
npm run typecheck     # TypeScript strict mode, src/ and __tests__/
npm run lint          # ESLint, src/ and __tests__/
npm run build         # compile to build/
```

Tests use isolated temp SQLite databases per suite (see `__tests__/setup.ts`) and inject the client via `setDb()`. Production code accesses the DB through `getDb()` in `src/db/client.ts`.

## License

MIT, see [LICENSE](LICENSE).
