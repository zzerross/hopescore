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

1. **Point the publish feature at your own fork.** `hopescore.html` has four
   hardcoded constants, in the "9. GitHub publish" section near the bottom
   of the script:
   ```js
   const GH_REPO_OWNER = 'zzerross';
   const GH_REPO_NAME = 'hopescore';
   const GH_REPO_BRANCH = 'main';
   const GH_FILE_PATH = 'hopescore.html';
   ```
   Change `GH_REPO_OWNER`/`GH_REPO_NAME` to your fork. **If you skip this,
   the in-app "Publish" button will try to commit to the original repo**
   using whatever GitHub token your editors enter. For most people that
   just fails with a permission error — but not for someone who happens to
   also be an editor on the *original* team and reuses a token they already
   have on hand while testing your fork. That token has real write access
   to the original repo, and publishing from your unconfigured fork would
   silently overwrite its live content. `publishToGithub()` has a safety
   net for exactly this: when the page's actual hosting domain doesn't
   match `GH_REPO_OWNER`'s expected `*.github.io`, it hard-blocks the
   publish entirely — a single-button "Close" modal, no "continue anyway,"
   no way to proceed. That's a last-resort catch, not a substitute for
   changing the constant.
2. **Enable GitHub Pages on your fork.** Repo Settings → Pages → Deploy
   from branch → `main` / root. This is a manual step in GitHub's web UI;
   no amount of editing the repo does this for you.
3. **Decide what to do with the seed data.** The file ships with one
   team's actual songs and weekly setlists baked in (see "Seed data" below)
   as a working example. Either replace it with your own songs or clear it
   out — see that section for how.
4. **Rename the app** if you want your own team's name instead of
   "HopeScore" — it appears in the `<title>` tag in both `hopescore.html`
   and `index.html`, and in the publish commit message template
   (`` `Update songs & setlist from HopeScore app...` `` in section 9).
   Cosmetic only, safe to change anytime.

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
  commit. Because the token is shared, `publishToGithub()` checks
  `location.hostname` against `GH_REPO_OWNER` before publishing and
  **hard-blocks the publish** if they don't match — a single-button
  "Close" alert with no bypass, not a dismissible confirm. It's deliberately
  not a warning someone can click through: a confirm with a "continue
  anyway" button protects nobody, since the only people who'd ever see it
  are either a legitimate editor on the real site (who never sees it at
  all, because their hostname always matches) or exactly the fork-owner/
  mistaken-token case it exists to stop — and that case would just click
  through too. So there's no second button; publishing simply doesn't
  happen on a mismatch, period. The check is skipped for `file://`/
  localhost/`127.0.0.1`, so it never fires during local dev or the
  Playwright-based testing described below. This is what actually catches
  a fork that forgot to update those constants, not just the README
  telling people to do it. If you ever change what `GH_REPO_OWNER` means
  or how the page is hosted (e.g. a custom domain via a `CNAME` file),
  update this check too, or it'll either stop firing when it should or
  start firing on your own legitimate deploy.
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
