# agentic-spaced-repetition

A spaced-repetition engine built for agents. It schedules flashcards with FSRS, keeps the deck in a
local SQLite database, and is driven by an LLM agent (over MCP) as much as by a person. Written in
TypeScript on Prisma/SQLite, formerly `flashcard-mcp`.

What makes it an engine for agents rather than a flashcard app:

- **FSRS scheduling** through `ts-fsrs` (FSRS-6). Learning steps, desired retention and weights mirror
  Anki's, so the same deck can be reviewed in Anki.
- **Code cards** are answered by running them (after Execute Program): a `predict`, `fill` or
  `compose` card holds an exercise that is run in a sandbox (bubblewrap, no network) for Ruby,
  Python, JavaScript, TypeScript or Postgres (PGlite), and compared by value. `check_code_card`
  dry-runs a draft; a card whose solution fails is refused at write time.
- **LLM grading** of typed answers: the Claude API (Haiku) suggests a rating and a one-sentence
  reason against a fixed rubric. It only suggests; the person or agent rates.
- **Write-time content rules** (`src/core/content-rules.ts`): HTML-only fields, an answer of at most
  150 visible characters and three sentences, one question on the front, clozes only on code cards.
  A card that breaks them is rejected with a message that says how to fix it.
- **Pressure and calibration.** `check_pressure` reports the review backlog and today's intake as
  `ok`, `warn` or `pause`, and card creation is refused while it says `pause`. `check_calibration`
  reports true retention over 30 days against an 80-90% band, so difficulty can be tuned without
  touching the rating rubric.
- **Leeches are enforced**: a card past the lapse limit blocks the next review until it is
  rewritten, split, deleted or explicitly kept.
- **Duplicate detection** on fronts (Jaccard) and meaning (384-dim embeddings, optional).
- **Anki sync partner.** The deck reaches AnkiWeb through the [study repo](../study)'s `anki-sync`,
  which reads and writes it only through the app server (`syncApply`).

## Architecture

```
CLI (src/cli)  ───────┐
MCP server (src/mcp) ─┼── SDK (src/sdk/index.ts) ── core (src/core/*) ── Prisma/SQLite
App server (src/app) ─┘
```

- **Core** (`src/core/`) holds every rule and every query: scheduling, pressure, calibration,
  leeches, content rules, exercises, sync.
- **SDK** (`src/sdk/index.ts`) is a facade over the core. It is the only thing the adapters import
  (`__tests__/sdk/boundary.test.ts` fails on a deeper import). A new capability is a core function,
  exported from the SDK, then a one-line adapter method.
- **Adapters** only translate transport:
  - the **MCP server** (`src/mcp/server.ts`), 32 tools over stdio for Claude Code or any MCP client;
  - the **app server** (`src/app/server.ts`), newline-delimited JSON over stdio, for programs;
  - the **admin CLI** (`src/cli/index.ts`, bin `srs`): `overview`, `easy-days`, `db:dump`,
    `db:restore`. Nothing that studies or edits cards goes through it.

Nothing outside this repo opens `prisma/master.db`. The database file name stays `master.db`; it
is data, and a machine that already has one keeps using it.

## Setup

```bash
npm install                  # then `npx prisma generate` if the Prisma client is missing
npm test && npm run typecheck && npm run lint
```

The database is `prisma/master.db`, or the SQLite file in the `DATABASE_URL` environment variable
(`file:/path/to/deck.db`). Every start of any adapter creates it if missing and pushes schema
changes to it (backing the file up first). Use a throwaway `DATABASE_URL` for experiments.

Code cards need `bubblewrap` and, for Ruby and Python, those interpreters (found through `mise`).
The embedding model for duplicate detection is downloaded on first use; set
`FLASHCARD_EMBEDDINGS=off` to skip it. Grading reads `ANTHROPIC_API_KEY`.

### MCP server

```bash
npm run dev:mcp
```

Register it in an MCP client under any name; the tool prefix follows the name. The study repo
registers it as `srs`, so its tools are `mcp__srs__*`:

```json
{
  "mcpServers": {
    "srs": {
      "command": "npx",
      "args": ["tsx", "/path/to/agentic-spaced-repetition/src/mcp/server.ts"],
      "env": { "DATABASE_URL": "file:/path/to/agentic-spaced-repetition/prisma/master.db" }
    }
  }
}
```

Tools:

- Sessions: `start_session`, `get_next_card`, `submit_review`, `skip_card`, `adjust_session`,
  `end_session`, `resolve_leech`
- Cards: `create_card`, `get_card`, `update_card`, `delete_card`, `delete_cards`, `list_cards`,
  `search_cards`, `suspend_card`, `unsuspend_card`, `find_similar_cards`, `get_due_cards`
- Code cards: `create_code_card`, `update_code_card`, `check_code_card`, `run_code_card`,
  `reveal_code_card`
- Card notes: `list_card_notes`, `resolve_card_note`
- Decks and stats: `list_decks`, `get_deck_stats`, `delete_deck`, `get_stats`, `check_pressure`,
  `check_calibration`, `get_session_history`

### App server

```bash
DATABASE_URL=file:/path/to/deck.db npm run dev:app
```

One long-lived process per client. It prints `{"ready": true}` once, then answers one JSON line per
request: `{"id", "method", "params"}` in, `{"id", "result"}` or `{"id", "error": {"message"}}` out.
Requests run concurrently, so match replies by `id`. Datetimes are ISO-8601 UTC strings. Methods:

- Study loop (Omvida): `startSession`, `nextCard`, `grade`, `review`, `undoReview`, `skip`,
  `endSession`, `resolveLeech`, `runExercise`, `revealExercise`
- Deck: `cards`, `searchCards`, `deleteCard`, `recentlyStudied`, `notes`, `setNote`, `sessions`,
  `overview`, `stamp` (change tokens `{stamp, reviews, notes}` that move when any process edits a card, reviews one or writes a note)
- Plain data for other programs: `cardRecords {ids?, inheritedFrom?, includeSuspended?}`,
  `reviewRecords {cardIds?}`, `tombstones`, `calibration`, `deckOverview`,
  `syncApply {schedules?, reviews?, imports?, deletions?, schedulerOptions?}` (one transaction)

CLAUDE.md has the details and the reasons behind them.

### Admin CLI

```bash
npm run dev:cli -- overview [--pending N]     # pending cards and progress picture, as JSON
npm run dev:cli -- easy-days [--apply]        # move reviews off Easy Days' reduced days (dry run without --apply)
npm run dev:cli -- db:dump <file>             # portable SQL dump
npm run dev:cli -- db:restore <file> [--force]
```

After `npm run build` and `npm link` (or a global install) it is the `srs` binary.

## Who uses it

- **[study](../study)** (Claude Code workspace): the MCP server for `/study` and the flashcard
  skills, with a PreToolUse hook that judges every card write. Its Python client
  (`scripts/deck/client.py`, used by `anki-sync`, the card-quality gate and sweep, `card-links-sync`)
  and the wiki-viewer (`wiki-viewer/lib/deck-client.ts`) both spawn the app server and call its plain-data
  methods. The checkout's location is `SRS_DIR` in study's `.env.local` (the old name
  `FLASHCARD_MCP_DIR` is still read).
- **[Omvida](../omvida)** (Quickshell desktop app): a study loop, deck browser and bar widget over
  the app server (`bin/omvida-deck`) and the CLI's `overview`.

## Behaviour worth knowing

`check_pressure` is the single source of truth for due counts and the verdict, on two axes: review
backlog (due cards excluding state New; warn at 20, pause at 50) and cards added today (warn at 5,
pause at 15). `create_card` is blocked at `pause`; `inheritFrom` splits and `update_card` are always
allowed, and a split of an already-studied card does not count as intake.

`check_calibration` counts reviews with `elapsedDays >= 1`, the first per card per local day, rated
3 or better, and answers `over-difficult`, `calibrated`, `under-difficult` or `low-signal` (fewer
than 50 eligible reviews, or more than 80% of ratings Good).

Leeches: `get_next_card` flags a card at 5 lapses and the next call errors until the card is
rewritten (`update_card`), split (`create_card` with `inheritFrom`, then `delete_card`), deleted, or
kept with `resolve_leech(action: "defer")`.

Deletion is explicit state: `delete_card` writes a `DeletedCard` tombstone, which the Anki sync reads
so a deletion reaches every machine. Card CUIDs must stay stable, since they are the Anki note guids.

## License

MIT, see [LICENSE](LICENSE).
