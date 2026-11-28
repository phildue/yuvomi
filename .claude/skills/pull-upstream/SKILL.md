---
name: pull-upstream
description: Use when asked to check upstream (ulsklyc/yuvomi) and integrate its latest changes into the phildue/yuvomi fork - merge the newest upstream tag on a sync branch, get CI green, and follow the automatic release after Phil merges.
---

# Pull upstream into the yuvomi fork

Run from `/home/dev/projects/yuvomi`. Phil merges the PR; you never merge. Production
(`yuvomi.phild.eu`, LAN) stays off limits, including after the release deploys.

The fork releases every merged `sync/upstream-X.Y.Z` PR as `vX.Y.Z` by itself
(`.github/workflows/release-on-sync-merge.yml`). That is why the branch name and the PR body matter.

## 1. Fetch and size the gap

```bash
git fetch upstream --tags      # old v2.76.0/v2.77.2 are "rejected: would clobber" - harmless
git fetch origin main
git log --oneline main..upstream/main | wc -l
git describe --tags upstream/main    # newest upstream release = the sync target
```

Nothing to do if `upstream/main` is already merged. Sync to the newest **release tag**, not to
`upstream/main` (the workflow checks that `package.json` equals the branch version).

**A fork feature merged to `main` on its own does not release.** `release-on-sync-merge.yml` only
reacts to `sync/upstream-X.Y.Z` branches (a normal PR shows "Release on upstream sync merge:
skipped"). Fork changes ship with the next sync; when Phil says "release it", do the next upstream
sync and say so. Never tag by hand: a `v*` tag deploys to production and would collide with
upstream's numbering.

## 2. Merge in a worktree

```bash
git worktree add -b sync/upstream-X.Y.Z .worktrees/sync/upstream-X.Y.Z main
cd .worktrees/sync/upstream-X.Y.Z
git merge --no-ff --no-commit vX.Y.Z
```

- Branch name is exactly `sync/upstream-X.Y.Z`; the release workflow parses the version from it.
- Merge the tag, not a rebase. Commit message: `Merge upstream ulsklyc/yuvomi vX.Y.Z`, then a
  "Conflicts resolved:" list, one line per file with the reason.
- `CHANGELOG.md` always conflicts: fork entries stay under `[Unreleased]`, upstream's new release
  sections follow unchanged (no fork entry may end up inside an upstream section).
- Other conflicts (fork budget/meal MCP tools, budget stats, locales): keep both sides; upstream
  often renames helpers, so after resolving, grep the fork's code for imports upstream removed.
- `package.json`: the whole `test` chain is ONE line, so it conflicts whenever either side adds a
  suite. Take upstream's chain and re-insert each fork-only step (in HEAD, not in the merge-base)
  right after the step that preceded it in HEAD; split on ` && `, never edit by hand.
- **Textual conflicts are the easy part.** Upstream refactors (a try/catch stripped from every
  handler, validation moved into a new function) can leave fork code that merged without a
  conflict reading names that no longer exist in that scope: every request answers 500. For each
  file in the overlap list, read `git diff origin/main -- <file>` around the fork's code and run
  that area's suites. If upstream re-shaped a whole file, take upstream's version and re-apply the
  fork's changes from `git diff <merge-base> origin/main -- <file>` (with `-w`) instead of
  untangling the hunks.
- New upstream workflows: read their triggers (`schedule`, `workflow_run`) and repository guards;
  a cron job starts running in the fork the day it lands (e.g. the restore drill).
- Check overlap first: `comm -12 <(git diff --name-only $mb main|sort) <(git diff --name-only $mb vX.Y.Z|sort)`.
- Check `git diff main -- package-lock.json`; tell Phil if dependencies changed (`npm ci`).

## 3. Fix the known CI traps BEFORE pushing

**Changelog guard (every sync).** Fork CI only sees fork tags, so upstream releases that came in by
merge look like new release headings written by hand and `test/test-changelog.js` fails. Add every
merged upstream version **except the new `package.json` version** and except versions the fork
already tagged to `UPSTREAM_RELEASES_WITHOUT_FORK_TAG`. Locally this test passes either way (the
clone has upstream's tags), so do not trust the local result for it. Commit separately:
`test(changelog): upstream A and B came in by merge, untagged in the fork`.

**Fork code is held to upstream's newer checks.** Each of these went red on a sync or fork PR:
- `test:tsc-baseline` / Typecheck: new code must type-check clean; the baseline is a debt register,
  never raised for new files. Fork files that already carry errors may not gain any (declare new
  `state` fields, cast untyped `prefs`, JSDoc every helper parameter). Counts are per file and code.
- Lint baseline: `max-lines` 1500 per file; a fork file pushed over it is recorded in
  `lint-baseline.json` (upstream's own files stay just under).
- A new admin-only preference field needs a row in `test/admin-gates-table.js`, a valid and an
  invalid PUT case (with their expectations) plus the default values in `test/test-settings-registry.js` / `settings-registry-expected.json`
  (key ORDER too: new registry fields come right after `holiday_last_sync`, route views after
  them), and the default values in `test/preferences-answers-expected.js` (dump with
  `PREFERENCES_ANSWERS_DUMP`; same idea for `G9_DUMP` budget answers and `AUTH_ANSWERS_DUMP`).
  Check each differing row differs only by the fork's fields before overwriting it.
- A new test suite needs `test:<name>` in `package.json`, its step in the `test` chain, and a row in
  `docs/test-suites.md` (`test:suite-chain`).
- Reasons: a 400 reason belongs in `CASE_MESSAGES` of `public/utils/friendly-error.js`, a 403 in
  `REFUSAL_MESSAGES` (the status decides which table is read), the file naming the reason must be
  in the guard's list in `test/test-friendly-error.js`, and the sentence must exist in every file of
  `public/locales/` with a real translation (`test:i18n`, `test:i18n-translated`).
- Settings pages: every registry search option must be rendered statically on its page
  (`test:settings-copy`); never import one settings page from another by absolute `/settings/pages/...`
  path (link guard) or at all (it becomes a shared chunk and drops out of the service-worker
  precache, `test:sw-precache`); use a relative import only for non-sheet modules.
- Workflows: zizmor flags workflow-level `packages: write` / `id-token: write` once a workflow has
  two jobs (the fork's deploy job), so write permissions sit on the build job. The restore drill
  needs upstream's corpus databases, so it is skipped outside `ulsklyc/yuvomi`.

## 4. Test locally, but know the limits

- `npm run test-parallel` (~40 min, run in background, logs in the `/tmp/yuvomi-test-parallel-*` dir it prints).
- **Node 24 is required** (`engines`), the machine has Node 22. Installing is something to ask Phil
  about first; the approved way is `npm install node@24` into a throwaway folder under `/tmp` and
  `export PATH=<that>/node_modules/.bin:$PATH` in every command (shell state does not persist).
- A fresh worktree has no `node_modules`. If `package-lock.json` is identical to an existing
  worktree's (`cmp`), symlink its `node_modules` and add `node_modules` to
  `$(git rev-parse --git-path info/exclude)` (the ignore rule does not match a symlink); otherwise
  ask before `npm ci`. Suites that import `server/index.js` also need `npm run build` (`dist/`).
- The machine has 3 GB: `npm run typecheck` and a whole-project `tsc` are OOM-killed (exit 137).
  Check typing narrowly: a temp tsconfig in `/tmp` that `extends` the project's, with `include` of
  the touched files, `typeRoots` pointing at the worktree's `node_modules/@types`, and
  `NODE_OPTIONS=--max-old-space-size=2200`; count unique `file(line,col): error TSnnnn` per file and
  code and compare with `tsc-baseline.json`. CI's Typecheck stays the real check (~45 s).
- A merged sync with fork changes: run the suites of every area the overlap list names (calendar,
  tasks, settings, OpenAPI, i18n, baselines) before pushing, not just the changelog test.
- For any red test: rerun it, then run it on a pristine detached worktree of the upstream tag
  (`git worktree add --detach .worktrees/up-X.Y.Z vX.Y.Z`, remove it afterwards). Red there too =
  upstream's test, but CI will still be red, so it needs a fix anyway (step 5).

## 5. Push, open the PR, make CI green

```bash
git push -u origin sync/upstream-X.Y.Z
gh repo set-default phildue/yuvomi
gh pr create --base main --head sync/upstream-X.Y.Z --title "Sync upstream vX.Y.Z" --body-file -
```

The PR body **becomes the GitHub release notes**, so write it for that: what came in (versions,
commit count), conflicts, test status, dependency bumps. No placeholders.

Phil wants **green CI before merging**. CI runs `npm test` serially (~31 min) and stops at the
first red, so one fix can reveal the next. Loop:

1. `gh pr checks <n>`; when red: `gh run view <run> --log-failed > <scratchpad>/ci.log`, then
   `grep -E '\bnot ok\b|Process completed'` and read that test's block (strip the timestamps).
   Logs exist only once the WHOLE run has finished (wait for it in the background; `gh api .../logs`
   may be denied, do not work around it). The failing test's own output is the artifact
   `test-logs-node-26.x`: `gh run download <run> -n test-logs-node-26.x -D <empty dir>`. Typecheck
   prints every key over the baseline as `file  TSnnnn  old -> new`.
2. Reproduce locally. If it only fails in CI, work out what differs (tags, missing node_modules,
   timing, env) before changing anything - use systematic-debugging.
3. Fix the root cause in its own commit, push, wait for CI again
   (`until ! gh pr checks <n> | grep -qE 'pending|queued|in_progress'; do sleep 30; done`, run in background).
4. Say plainly that a green run cannot rule out later failures while CI is still stopping early.

Seen so far: changelog untagged-release guard (every sync); `test-wall-tasks` #46 timing race in
upstream's `settle()` (fixed by polling `inflight` every turn); upstream's `test:auth-answers`
pinned the version literal at the tag (fixed upstream a commit later, #2931: cherry-pick it with
`-x`); the fork's MCP/budget tests against upstream's new loopback harness; zizmor and the restore
drill (step 3); a fasting-insights browser test timing out once (30 s wait) and passing on the next
push - never push an empty commit or skip a test to get green. Offer upstream-worthy fixes to Phil;
never open anything on `ulsklyc/yuvomi`.

Tell Phil it is ready only when all checks pass: Tests Node 22 and 24, Fasting browser suite,
claude-review.

## 6. After Phil merges: watch the release

Nothing to push by hand. Expected chain on `main`:

1. `Release on upstream sync merge` (seconds): checks `package.json == X.Y.Z`, the tag does not exist,
   creates release `vX.Y.Z` on the merge commit with the PR body, dispatches Docker Publish on the tag.
2. `Docker Publish` on `vX.Y.Z` (workflow_dispatch) pushes the image and runs its deploy job.
3. `Docker Publish` and `CI` on the `main` push run alongside.
4. `umbrel-publish.yml` fires on the published release.

Verify:

```bash
git fetch origin main
gh run list --limit 8
gh release view vX.Y.Z --json tagName,targetCommitish,isDraft,isPrerelease,publishedAt,url
git ls-remote --tags origin vX.Y.Z
gh run view <docker-publish-run>     # every job, incl. deploy
```

If the release job fails (`::error::` lines): wrong `package.json` version, tag already exists, or
branch name not `X.Y.Z`. Do not delete or move tags and do not re-run destructive steps without
Phil. Report the error and the fix options. Afterwards `git fetch origin --tags` locally; the fork's
`vX.Y.Z` now sits on the merge commit, while upstream's own tag points elsewhere (the earlier
"clobber" rejections are the same thing).

Finish with: PR link, release link, run results, and anything Phil must do (`npm ci`, deploy checks).
Remove finished sync worktrees only with Phil's OK.
