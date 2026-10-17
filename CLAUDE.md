# HopeScore

A single-file chord/lyric chart viewer and editor for a worship team's weekly
setlist, hosted on GitHub Pages. No backend, no build step, no framework —
`hopescore.html` is the entire app (inline `<style>` + `<script>`), served
as a static file. `index.html` just redirects to it, and `sw.js` is a
service worker for offline/PWA support.

Read this file before making changes. It covers the data model, the publish
flow, and several non-obvious traps that have each cost real debugging time
in this project's history — they're flagged explicitly so you don't
rediscover them the hard way.

## If you just forked this repo for your own team

Do these **before** anything else, in order:

1. **Enable GitHub Pages on your fork.** Repo Settings → Pages → Deploy
   from branch → `main` / root. This is a manual step in GitHub's web UI;
   no amount of editing the repo does this for you.
2. **Decide what to do with the seed data.** The file ships with one
   team's actual songs and weekly setlists baked in (see "Seed data" below)
   as a working example. Either replace it with your own songs or clear it
   out — see that section for how.
3. **Rename the app** if you want your own team's name instead of
   "HopeScore" — it appears in the `<title>` tag in both `hopescore.html`
   and `index.html`, and in the publish commit message template
   (`` `Update songs & setlist from HopeScore app...` `` in section 9).
   Cosmetic only, safe to change anytime.

That's it — **you don't need to touch the publish target.** `hopescore.html`
has two override constants in the "9. GitHub publish" section near the
bottom of the script:
```js
const GH_REPO_OWNER_OVERRIDE = '';
const GH_REPO_NAME_OVERRIDE = '';
const GH_FILE_PATH = 'hopescore.html';
```
Left blank (the default), `GH_REPO_OWNER`/`GH_REPO_NAME` are inferred from
`location.hostname`/`location.pathname` at load time — GitHub Pages URLs are
predictable enough (`<owner>.github.io/<repo>/...` for a project page, or
just `<owner>.github.io/` for the one user/org page per account) that the
page can read its own owner/repo back out of where it's actually hosted, no
constant to edit and no network call needed. The branch doesn't need
figuring out either — the GitHub Contents API already defaults to the
repo's own default branch whenever a request omits `ref`/`branch`, so the
code just omits it. Fork, enable Pages, and publish already points at
*your* repo.

The only setup this can't see through is a **custom domain** (a `CNAME`
file) — there's no owner/repo encoded in an arbitrary hostname, so it falls
back to the original `zzerross`/`hopescore` default and you'll need to fill
in the matching `*_OVERRIDE` constant yourself. If you skip that step on a
custom domain, `publishToGithub()` hard-blocks publishing rather than
risk writing to the wrong repo — see "Known traps" below for exactly when
that guard fires and why it has no bypass.

Everything else below is context for actually working on the code, not more
one-time setup.

## Architecture

- **One file is the app.** All CSS is in one `<style>` block, all JS in one
  `<script>` block at the bottom, both inline in `hopescore.html`. There is
  no bundler, no npm install, no transpilation — edit the file directly and
  reload the browser.
- **No backend.** The "server" is GitHub Pages serving this static file.
  "Publishing" a change means committing a new version of `hopescore.html`
  straight to the repo via the GitHub REST API, called directly from the
  browser with a user-supplied personal access token (see "Publish flow"
  below). There is no server-side validation, auth, or database anywhere.
- **Offline support** comes from `sw.js`, a network-first service worker
  that caches `hopescore.html`/`index.html`/`./` and falls back to the
  cached copy only when the network is unavailable.
- **The script is organized into 10 numbered sections** (search for
  `/* ====` comment banners), in this order: 1. Chord theory (note math,
  transpose, Nashville numbers) · 2. Parser (plain text → blocks) ·
  3. Column realignment · 4. Storage · 5. Small UI helpers (modal, toast,
  router) · 6. Chart renderer (shared by song view + Present mode) ·
  7. Views (home/song/edit) · 8. Present (fullscreen) mode · 9. GitHub
  publish · 10. Init. Grepping for the section title is the fastest way to
  orient yourself.

## Data model

`STATE` is one in-memory object, persisted to `localStorage` on every
change via `saveState()`. It has four top-level keys, and they are **not**
treated the same way:

- `STATE.songs`, `STATE.setlists` (keyed by date, `"YYYY-MM-DD"`),
  `STATE.printPrefs` — **publishable**. These are meant to be shared across
  the whole team, and flow through the publish pipeline described below.
- `STATE.settings` — **device-local only, never published.** Per-device
  preferences: font size, line spacing, Present theme, video player size,
  etc. Many of these are bucketed per-song-per-view (e.g. `fontSizeBySongView`
  keyed by `"chords:<songId>"` vs `"prompter:<songId>"`) so a vocalist's
  Prompter screen and an instrumentalist's Chords screen remember their own
  size independently.

### Seed data

The three publishable fields are seeded from constants baked directly into
`hopescore.html`, inside `seedState()` (section 4, Storage), bounded by
marker comments the publish code searches for and rewrites verbatim:

```
/* SEED_SONGS_START */ ... /* SEED_SONGS_END */
/* SEED_SETLISTS_START */ ... /* SEED_SETLISTS_END */
/* SEED_PRINT_START */ ... /* SEED_PRINT_END */
```

To start your team with an empty library, replace the `seedSongs` array
with `[]` and `seedSetlists` with `{}` inside those markers (printPrefs can
stay as-is — it's just default print layout settings). Don't touch the
marker comments themselves; `publishToGithub()` does a literal string
search for them.

### Song body text: blank lines are canonicalized on save

A song's `body` is free-form chord/lyric chart text — see `parseBody()`
(section 2) for the actual line-by-line parsing rules (chord-line
detection, section-header detection, the `##` custom-section-name escape
hatch). One narrow but important rule about it: **blank lines in `body`
are not preserved as typed.** `normalizeBodyBlankLines()` (section 2,
right after `parseBody()`) runs on every save from the song editor (both
adding a new song and editing an existing one — the two `body: ...`
assignments in the save handler, section 7) and rewrites `body` to:

1. Drop every blank line the editor typed, then
2. Insert exactly one blank line between consecutive "parts" — a section
   header (`Verse 1`, `Chorus`, an auto-detected `Intro`, a custom `##`
   name, etc.) plus everything that follows it up to the next header, with
   any content before the very first header treated as its own leading
   part.

This isn't just a formatting preference. `parseBody()` only renders a
chord line stacked directly above its lyric (a "pair") when the two are
*adjacent* raw lines with nothing between them — a stray blank line
between what was meant to be one chord+lyric pair silently breaks that
pairing, so the chord renders as its own disconnected line instead of
aligned over the right syllable, with a visible gap where the blank line
used to be (a blank row's height doesn't scale with the `lineSpacing`
setting, so this always looks "wrong" no matter what that's set to).
Content pasted in from other chord-chart sources commonly comes
double-spaced like that throughout; normalizing on save fixes both the gap
and the broken pairing at once, and is a pure line-level transform
(chord/lyric text itself is never touched), so it's safe to re-run and
always idempotent. It only runs at *save* time, not live while typing —
the editor's live preview intentionally mirrors the textarea exactly as
typed, so what you see while editing matches your actual draft, not a
silently-rewritten version of it.

This rule was also applied once, retroactively, to every song already in
`seedSongs` — not just enforced going forward. 29 of the 37 songs at the
time had at least one blank line in a place this rule removes; 4 of those
had *every* chord+lyric pair in the entire song broken this way (zero
actual chord/lyric pairs anywhere in the song, every chord line floating
disconnected above its lyric instead of aligned over it) before the fix.
If you're importing a chart from elsewhere, paste it as-is and let the
editor's Save button normalize it rather than hand-cleaning the blank
lines first.

### Publish flow

An "editor" is just a device that has a GitHub personal access token and a
display name saved in `localStorage` (Settings → Editor login). Anyone with
the token can publish — there's no per-user permission model beyond "has
the shared token or not." Publishing (`publishToGithub()`, section 9):

1. Fetches the current `hopescore.html` from GitHub via the Contents API.
2. Rewrites the three `SEED_*` blocks with the local `STATE.songs` /
   merged setlists / `STATE.printPrefs`, serialized with `JSON.stringify`.
3. Commits the new file back via a `PUT` to the Contents API, with the
   editor's name stamped as the git author (the shared token's account is
   always the committer — GitHub requires that match).
4. GitHub Pages redeploys the new `hopescore.html` automatically
   (typically under a minute).

Setlists merge rather than overwrite on publish (`mergeSetlistsForPublish()`)
so two editors building different weeks' setlists concurrently don't
clobber each other. Songs do not merge — last publish wins for a given
song id.

### Why "unpublished changes" detection is more involved than it looks

An editor's local `STATE` is their own draft, kept across reloads so an
in-progress edit survives a refresh. But it needs to tell "I actually
edited this" apart from "this is just unchanged, and someone else
published something new that my stale draft doesn't have yet" — getting
this wrong either loses real edits on reload, or shows a permanent false
"unpublished changes" banner to someone who never touched anything. If you
touch `loadState()`, `hasUnpublishedChanges()`, or the `*Signature()`
functions (section 4), **read them in full first** — this logic has been
wrong in two genuinely subtle ways in this project's history already (both
now fixed, but worth understanding why):

- The three `*Signature()` functions (`songsSignature`, `setlistsSignature`,
  `printPrefsSignature`) exist specifically so two differently-shaped-but-
  equivalent objects (e.g. an old saved `printPrefs` missing a field a
  newer version added, vs. the current default-filled shape) still compare
  equal. If you add a new field to one of these three data shapes, make
  sure its signature function's default-merge covers it, or old
  local/published data will permanently miscompare against new data.
- `loadState()` tracks `LAST_SEEN_SEED_KEY` (and falls back to this
  device's own last-published cache, `GH_LAST_PUBLISHED_*_KEY`, ignoring
  its trust window) to distinguish a genuinely-edited local draft from one
  that's simply stale. When it decides a field is unedited and adopts the
  fresh seed for it, **it writes that correction back to `localStorage`
  immediately**, not just into the in-memory `STATE` for that one load — if
  you refactor this, keep that write; without it, the correction only
  lasts one page load and the next reload can regress it right back to
  looking stale again.

## Known traps

- **TDZ (temporal dead zone) in `loadState()`.** `let STATE = loadState()`
  runs near the top of the script, but `loadState()` is wrapped in a
  `try/catch` that silently swallows errors and falls back to a bare
  `seedState()` — discarding the *entire* local draft, not just whatever
  field you were working on. If `loadState()` (or anything it calls, like
  one of the `*Signature()` functions) references a `const` that is
  declared *later* in the file than `loadState()`'s own call site, that
  throws a `ReferenceError` and gets silently eaten. This has happened
  twice in this project already. If `loadState()` needs a new constant,
  either declare that constant above `loadState()`'s definition, or move
  the `let STATE = loadState()` call — don't assume declaration order
  doesn't matter just because JS hoists `function` declarations (it does
  hoist those; it does *not* hoist `const` initializers).
- **A chord line is recognized (or not) as a WHOLE — one unrecognized
  token on it silently drops the entire line out of chord parsing**,
  not just that token. `lineIsChordLine()` (section 2) requires *every*
  whitespace-delimited token on a line to pass `isChordToken()` before the
  line counts as a chord line at all; if even one token fails, the whole
  line falls through to `lyricOnly` instead — meaning it never gets a
  `chordTokens` array, so transpose/Nashville/key-change silently leave it
  exactly as typed while every other line in the song changes around it.
  This shipped for real: a bar-notation progression using glued slash-
  rhythm notation per bar (`| A /// | D/A /// |`, "hold this chord 3 more
  beats") had its `///` tokens fail `isChordToken()` — a single `/` was
  recognized (a literal `SPECIAL_TOKENS` entry), but a run of more than one
  glued together wasn't, since nothing matched that shape. The fix,
  `MULTI_SLASH_RE` (`/^\/+$/`, replacing the old single-`/` entry since it
  subsumes it), is deliberately a general "any run of slashes" check, not
  specifically "exactly 3" — so `//`, `////`, etc. are covered too, not
  just the one case that was reported. If you add another bar-notation
  symbol, remember it has to make `isChordToken()` return `true` for
  *every* occurrence on the line, not just render correctly once it's
  already classified as a chord token — the two are different code paths
  (`lineIsChordLine()` classifying vs `transposeChord()`/`toNashville()`
  transforming), and this bug was entirely in the first one.

  This left one real song's seed data (`"Build my life"`) in a genuinely
  inconsistent state, not just a display glitch: its `keySemitone` and
  Verse/Chorus/Bridge chords had been hand-corrected to B (presumably by
  retyping them from what the live Transposed view correctly showed,
  since there's no "commit a transpose into the body" feature — Transpose
  mode only ever affects the live render, see `openKeyModal()`), but
  Intro and Interlude — both using this exact glued-slash notation, so
  both silently frozen by the bug — had nothing correct to copy from and
  were left in the old A-key text, declaring themselves part of a B-key
  song while still literally reading `A`/`D/A`/`A/C#`. Retroactively
  transposed those two lines' body text from A to B (`+2` semitones) to
  match the rest of the song, verified against this fix's own
  `transposeBodyText()` output rather than hand-typed. If another song
  turns up with a similar mismatch — a declared key its body text doesn't
  actually match on some lines — this bug (now fixed) is the likely
  reason; check whether a bar-notation line was the one left behind.
- **YouTube embeds use `youtube.com`, not `youtube-nocookie.com`, on
  purpose.** The privacy-enhanced `-nocookie` domain withholds the
  viewer's own YouTube session from the embed by design, which means a
  signed-in viewer (including anyone with YouTube Premium) always sees ads
  in the embed regardless of their browser's actual login state. Don't
  "fix" this back to `-nocookie` without knowing that tradeoff.
- **Video embeds need `playsinline=1` and a real minimum size.** Below
  roughly 260px wide, YouTube's embedded player doesn't render its own
  interactive controls and taps bounce out to the native app instead of
  playing inline (confirmed on a real Android device, not a browser
  quirk you can work around with CSS). `VIDEO_SIZES` encodes this — don't
  add a smaller preset without retesting on a real phone.
- **This is a single shared GitHub token model**, not per-user auth.
  Don't build anything that assumes a song or setlist's "owner" can be
  reliably identified beyond the free-text editor name stamped on the git
  commit.
- **`GH_REPO_OWNER`/`GH_REPO_NAME` are inferred from `location`, not
  hardcoded** (see "If you just forked this repo" above) — `inferGhRepoFromLocation()`
  reads them back out of `location.hostname`/`location.pathname` using
  GitHub Pages' own predictable URL shape, so a plain fork at a standard
  `*.github.io` address publishes to itself with zero constants to edit.
  This means a fork can never *accidentally* point at the original repo
  just by forgetting to update a constant — there's no constant to forget.
  What's left is the narrower case: a custom domain, where inference can't
  recover any owner/repo from an arbitrary hostname and falls back to the
  hardcoded `zzerross`/`hopescore` default, or someone explicitly setting a
  `*_OVERRIDE` that doesn't match where the page is actually hosted. For
  those, `publishToGithub()` checks `location.hostname` against the
  resolved `GH_REPO_OWNER` before publishing and **hard-blocks the
  publish** if they don't match — a single-button "Close" alert with no
  bypass, not a dismissible confirm. It's deliberately not a warning
  someone can click through: a confirm with a "continue anyway" button
  protects nobody, since the only people who'd ever see it are either a
  legitimate editor on the real site (who never sees it at all, because
  their hostname always matches) or exactly the custom-domain/mistaken-
  token case it exists to stop — and that case would just click through
  too. So there's no second button; publishing simply doesn't happen on a
  mismatch, period. The check is skipped for `file://`/localhost/
  `127.0.0.1`, so it never fires during local dev or the Playwright-based
  testing described below. If you ever change what `GH_REPO_OWNER` means
  or how the page is hosted (e.g. a custom domain via a `CNAME` file),
  update `inferGhRepoFromLocation()` and this check too, or it'll either
  stop firing when it should or start firing on your own legitimate
  deploy.
- **No automated test suite or CI ships in this repo.** Verification
  during development has consistently been ad-hoc Playwright scripts
  (headless Chromium), written per-change and run manually — not checked
  into the repo, since they're throwaway/scratch, not a maintained suite.
  If you set up testing for your fork, serve the file over a real local
  HTTP server rather than opening it as `file://` — several browser
  behaviors (fetch, service worker registration, YouTube embeds'
  `canEmbed` check based on `location.protocol`) only work correctly over
  http(s). Mock `https://api.github.com/repos/**` with Playwright's
  `page.route()` to test the publish flow without hitting a real repo.

## Read-only view layout invariants

Two hard requirements apply to every read-only view (Chords, Prompter,
Present, and the A4 print preview) that lays chord/lyric content into
columns or pages — not just the print view, even though that's the only
one currently affected in practice (see "If you're moving more views
toward A4 proportions" below). Keep both in mind before touching
`wrapRows()`/`wrapAligned()` or `paintPrintPreview()`'s section-grouping
(all section 6/7) — a real, shipped bug in each of these shape this
section, not a hypothetical concern.

1. **A part (a section header plus its chord/lyric rows — Verse, Chorus,
   Bridge, an auto-detected "Intro", etc.) must never be split across a
   column or page break.** If a part doesn't fit in what's left of the
   current column/page, the *whole part* moves to the next one — never
   half of it. In the print view this is `groupRowsIntoParts()` wrapping
   each part in its own `.print-part`, with that class's `break-inside:
   avoid` doing the actual enforcement at render time. The on-screen
   Chords view's own column layout (`flowFit()`/`chunkRows()`) already had
   an equivalent, independently-written safeguard before this was
   documented — it groups by *blank-line* boundaries rather than by
   section headers, which is usually equivalent (this app's convention is
   a blank line between parts) but isn't guaranteed to be if a song's body
   ever breaks that convention. If you ever unify these two mechanisms,
   prefer the section-header-based grouping (`groupRowsIntoParts()`) as
   the more precise definition of "part" — that's literally what the word
   means here. The one case this can't fix: a single part taller than an
   entire column/page — `break-inside:avoid` can only move content as a
   unit, it can't shrink it to make it fit, and nothing here attempts to.
2. **A single chord token must never be split across a wrapped line —
   ever.** `Dm7` rendered as `D` on one line and `m7` continuing the next
   is always a bug, no matter how narrow the column. This shipped for
   real: `wrapAligned()`'s break-point search used to be based only on the
   *lyric* line's spacing (the "primary" text passed to the old
   `findBreakPoints()`), not the chord line's — a chord sits wherever its
   change happens in the lyric, often mid-word, so a perfectly good lyric
   word-wrap point could land (and did land, in production) in the middle
   of a chord token on the line above it. `findBreakPoints()` now requires
   a cut position to be safe for *both* strings at once (`isSafeCutPoint()`),
   and if the column is so narrow that no safe point exists within budget,
   it searches forward past `maxChars` for the next one rather than ever
   slicing a token — the same thing a browser does on its own for an
   unbreakable long word under normal text wrapping (it overflows instead
   of getting mangled).

### If you're moving more views toward A4 proportions

The print view is the only one of the four read-only views that currently
lays content into real *pages* (not just columns) and enforces both
invariants above. If the A4 print view's layout holds up well enough to
become the shared layout engine for some or all of the on-screen views too
— an idea under consideration for this project, not yet started — both
invariants need to keep holding for whichever views adopt it; they're
requirements of the *layout*, not something specific to printing.
`wrapRows()`/`wrapAligned()` already don't know or care whether their
caller is on-screen or print, so invariant 2 travels for free to any new
caller. Invariant 1 (`groupRowsIntoParts()` + `.print-part`'s
`break-inside:avoid`) is currently wired up only inside
`paintPrintPreview()` and would need deliberately carrying over to
wherever else starts doing paginated or columned layout — it won't happen
automatically just by reusing `wrapRows()`.

### Auto/Manual is one toggle button, not two, and the pattern is the same in all three fit-mode views

Three places in the app let you pick between an auto-computed size and a
fixed one: the Chords view (`#fitToggle`), Present (`#presentFitToggle`),
and the A4 print view (`#printFitToggle`). All three render as a single
`<button class="iconbtn">` labeled `Auto`, highlighted (`.primary`) when
on — not two segmented buttons (`[Auto][Manual]`) like earlier in this
project's history. The two states (`fitMode` is always exactly `'auto'` or
`'wrap'` internally, everywhere) are mutually exclusive by construction, so
a second button for the off-state never said anything a plain on/off
toggle didn't already say — once this was pointed out, keeping it as two
buttons stopped making sense anywhere it appeared. The stored value stays
`'wrap'` (not renamed to `'manual'`) for continuity with existing
device-local `localStorage` data; only the displayed label reads `Manual`
(print toolbar) or is simply absent (Chords/Present just show the single
`Auto` button unhighlighted) — don't confuse the stored string with
whatever's actually displayed when reading this code.

**Turning Auto off freezes what Auto was just showing, not a stale stored
value.** Before this, clicking directly to leave Auto (not via A−/A+) fell
back to whatever fixed size/columns happened to be stored from a previous
Manual session (or a never-touched default) — which could be a completely
different size than what you were just looking at, a jarring jump. Now
each view's toggle handler seeds the Manual value from the real, just-
rendered Auto result before switching:
- Chords: `lastAutoFontSize` (set in `repaint()`'s Auto branch from
  `layoutChart()`'s own `result.size`) is written into this song's stored
  `chords` font size.
- Present: `presentLastAutoFontSize` (same idea, set in `paintPresent()`'s
  `requestAnimationFrame` callback) is written into this song's stored
  `chords` font size (only relevant with chords shown — chords-hidden is
  always Manual/fixed already, see `filterPresentRows()`'s caller).
- Print: `printLastAutoLayout` — Auto decides font size *and* column count
  independently per song, but Manual is one shared value for the whole
  batch, so there's no single unambiguous "current value" the way the
  other two views have one song in view at a time. The **first displayed
  song's** computed `{fontSize, columns}` is used as that seed — a
  reasonable representative pick, not a precise one.

A-/A+ continue to work exactly as before in every view (switch this song
to Manual, seeded from whatever delta was just applied — unrelated to the
freeze above, since an explicit delta already *is* the new value).

**A related gap this surfaced and fixed in passing**: the Chords/Present
font-size labels (`#fontSizeLabel`/`#presentFontLabel`) previously only
ever updated from the Manual-mode bump functions, so while Auto was active
they kept showing whatever was last stored for Manual — not the size Auto
was actually rendering at. This meant the number on screen didn't match
what the freeze-on-toggle-off above would capture. Both labels are now
also updated live, right after `layoutChart()`'s Auto branch resolves (see
`result.size` in both `repaint()` and `paintPresent()`).

### Printing has one entry point, not two

`renderHomeView()` used to have two separate ways into the A4 print
preview: the top-toolbar `🖨` button (`#btnPrintSetlist`, always printed
*this date's setlist*), and a second "Print preview (A4)" button that only
appeared in a bar beneath the library once you'd checked one or more songs
there (independent of any setlist — e.g. to proof a batch of new/edited
charts without staging them into a setlist first). Two buttons for
"print," picked by which one happened to be visible, was one too many.

`🖨` is now context-aware instead: if the library below has anything
checked (`selectedIds.size`), clicking it prints that selection; otherwise
it falls back to the date's setlist, exactly as before
(`openPrintPreview(date, selectedIds.size ? [...selectedIds] : undefined)`
— `openPrintPreview`'s own `songIds || null` turns that `undefined` back
into "use the setlist"). `syncPrintSetlistBtn()` keeps the button's
enabled state and tooltip (`Print this setlist` vs. `Print N selected
songs`) matching whichever mode it would actually act on right now; it's
called both from `paintSetlist()` (setlist changes) and
`paintSelectionBar()` (library selection changes), since either can flip
which mode that is. The library's own checkboxes, search, sort, and
select-all are untouched — only the print *trigger* moved, from a second
button to the existing one; the selection bar now just shows a count (no
`Clear` button — see below).

**No separate "Clear" button, on purpose.** Unchecking already covers
deselecting: one row at a time, or toggle the select-all checkbox off to
drop every *currently visible* one at once. A dedicated Clear button was
considered and dropped — `.library-select-bar` isn't sticky, so it scrolls
out of view right along with the select-all checkbox above it, meaning
Clear never actually saved a scroll-back-to-the-top trip the way a sticky
toolbar button might have. The one case unchecking doesn't cover as
directly: a selection built up across *several different search terms*
(searching "a," checking some, then searching "b" and checking more —
supported on purpose, see the comment on the select-all checkbox's own
`change` handler) — select-all only ever acts on what's currently visible,
so clearing a cross-search selection needs the search box cleared first,
then select-all toggled off. Left as a real but narrow rough edge rather
than reintroducing a button for it.

If you add a third way to build a song list to print (e.g. a future
"queue" — see the earlier queue discussion in this project's history), run
it through this same `🖨` + `selectedIds`-style pattern rather than adding
yet another print button.

### Experimental: per-song auto font size in the A4 print view

- **`Manual`** (the original default, unchanged behavior): one global font
  size and column count for every song in the batch, same as before this
  feature existed, adjustable with A−/A+ and the 1/2-column toggle.
  `renderPrintSongAt()` — relies on native CSS `column-count` to balance
  content across columns, since it only ever targets one sheet.
- **`Auto`**: decides, independently **per song**, the column count, page
  count, and font size that together get the content as large as possible
  while still satisfying *both* (a) the whole song fits, and (b) **no row
  needs to wrap at all** — not even one chord+lyric pair. Because Auto now
  decides columns itself, the 1/2-column toggle has nothing to apply to in
  this mode and is visibly disabled (`.seg.disabled`, toggled in
  `paintPrintPreview()`) rather than left clickable with no effect.

#### Auto's goal is the largest readable text, not the fewest columns

`searchAutoPrintLayout()`'s underlying premise: the person printing doesn't
care whether it's 1 column or 2, only that the text ends up as large as
page count allows — so column count is never a reason to stop searching
early. A song that already fits nicely in 1 column at some font might still
fit 2 columns at a *meaningfully bigger* one (each column only needs to
hold roughly half the lines), so **both column counts are always tried**,
and whichever reaches the larger font size wins (`bestForColumns()` finds
the best font for one fixed column count; `bestForPageBudget()` runs it for
both 1 and 2 columns and keeps the winner — a tie keeps 1 column, the
simpler layout, since it cost nothing to prefer it). This was deliberately
rebuilt from an earlier "ladder" version that stopped at the first column
count that fit *at all* (1 column first, 2 only as a fallback) — verified
against the real 37-song seed library that this under-used 2-column
headroom: several songs jumped by 2-6pt once 2-column was actually
compared against 1-column instead of only reached on 1-column's outright
failure (e.g. one real seed song went from 8pt/1-column to 14pt/2-column).

Page count is still a real escalation step, though, not folded into the
same "always try both" comparison — more pages always "helps" fit a bigger
font in the limit, which would defeat the one-sheet-per-song idea this
print view started from. So `bestForPageBudget(1)` (both column counts,
within a single page) is tried first; only if **neither** column count fits
within 1 page at any font down to `PRINT_FONT_RANGE`'s floor does the
search move to `bestForPageBudget(PRINT_AUTO_MAX_PAGES)` (currently 2) and
repeat the same 1-vs-2-column comparison there. If nothing satisfies both
conditions anywhere, it falls back to 2 pages/2 columns at the floor size
anyway, with wrapping allowed and any still-unplaced content appended to
the last page's last column — same "last resort" shape as `Manual` at too
large a font, or as the on-screen Chords view's own `flowFit()` fallback.

Because a song can now span more than one physical page, Auto can no longer
lean on native CSS `column-count` the way Manual does — deciding what
spills onto a *second* page requires knowing exactly where content gets
cut, which column-count balancing doesn't expose. So Auto measures and
places columns manually instead, mirroring the on-screen Chords view's own
`chunkRows()`/`countFittingChunks()`/`flowFit()` approach rather than
reusing it directly (print groups by `groupRowsIntoParts()`'s section-header
parts instead of Chords' blank-line chunks, and measures against a real A4
page's content height instead of the on-screen chart box):

- `countFittingPrintParts()` — binary-searches how many leading parts fit in
  one column (parallels Chords' `countFittingChunks()`).
- `flowPrintPage()` — fills up to a given column count for ONE page,
  newspaper-style, returning whatever didn't fit as `overflow` (parallels
  `flowFit()`).
- `bestForColumns()` — runs `flowPrintPage()` once per page for a *fixed*
  column count and page budget, feeding each page's `overflow` into the
  next, and returns the largest font size (and resulting page layout) that
  fits cleanly, or `null`.
- `renderAutoPrintSheets()` — renders the decided layout as one
  `.print-sheet-fit`/`.print-sheet` pair per page (`.print-cols`/`.print-col`
  flex children, placed at the already-decided widths — not CSS
  `column-count`, which would just try to re-balance content this code
  already placed deliberately). The title/description render only on the
  first page.

**A trap worth knowing if you touch this again**: the title/description
rows sit *above* the columns on page 1 only, but take up real height that
has to come out of page 1's budget before the columns get whatever's left.
An early version of this measured each page's columns against the *full*
page height on every page including page 1, which let page 1's columns
measure as "fitting" and then silently push past the real page boundary
once the title/description height was added back on render — invisible
on screen (the `.print-sheet-fit` wrapper just scrolls), but a real extra
page in the actual printed/PDF output, caught only by checking a real
`page.pdf()` page count, not by inspecting the DOM. `measurePrintHeadRowsHeight()`
+ `searchAutoPrintLayout()`'s internal `pageBudget(pageIndex, fs)` fixes
this: page 1's budget is `pageContentHeight - headRowsHeight`, every later
page gets the full `pageContentHeight`. If you change what renders above
the columns on page 1, make sure the budget calc still accounts for it.

Both Auto and Manual still reuse the same `wrapRows()`/`groupRowsIntoParts()`
primitives, so both read-only layout invariants above still hold regardless
of mode, column count, or page count.

This whole fit-mode toggle is deliberately stored in device-local
`STATE.settings.printFitMode`, not in the published `printPrefs` — the
per-song-vs-global question isn't settled yet (see the queue/per-view-
settings discussion this was born from), so it's kept as a local experiment
you can try without it affecting anyone else's view or getting published.
If/when a direction is settled, decide then whether this should move into
`printPrefs` (team-wide) or stay device-local permanently. This column/page
search is Auto-only by deliberate choice, not an oversight — Manual's whole
point is a user-chosen fixed size/column count, and "doesn't fit" isn't
really a Manual concept (it already accepts wrapping and scrolling overflow
by design).

## Making a change, end to end

1. Edit `hopescore.html` directly — no build step.
2. Syntax-check the script before testing in a browser:
   `node -e "require('fs').writeFileSync('/tmp/s.js', require('fs').readFileSync('hopescore.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1])" && node --check /tmp/s.js`
3. Open the file in a browser (ideally over `http://`, not `file://` — see
   above) and exercise the actual feature you changed.
4. Commit and push directly to your fork's default branch — GitHub Pages
   redeploys automatically. There's no PR/review gate in this project's
   own workflow (it's a small team's internal tool), but that's a choice
   you can change for your fork if you want one.
