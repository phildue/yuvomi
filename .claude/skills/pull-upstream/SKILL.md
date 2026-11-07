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
- Check overlap first: `comm -12 <(git diff --name-only $mb main|sort) <(git diff --name-only $mb vX.Y.Z|sort)`.
- Check `git diff main -- package-lock.json`; tell Phil if dependencies changed (`npm ci`).

## 3. Fix the known CI trap BEFORE pushing

Fork CI only sees fork tags, so upstream releases that came in by merge look like new release
headings written by hand and `test/test-changelog.js` fails. Add every merged upstream version
**except the new `package.json` version** to `UPSTREAM_RELEASES_WITHOUT_FORK_TAG`. Locally this
test passes either way (the clone has upstream's tags), so do not trust the local result for it.

Commit separately: `test(changelog): upstream A and B came in by merge, untagged in the fork`.

## 4. Test locally, but know the limits

- `npm run test-parallel` (~40 min, run in background, logs in the `/tmp/yuvomi-test-parallel-*` dir it prints).
- A fresh worktree has no `node_modules`; Node resolves the main checkout's, so
  `test:runtime-deps` fails there. That is the environment, not the merge.
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
2. Reproduce locally. If it only fails in CI, work out what differs (tags, missing node_modules,
   timing, env) before changing anything - use systematic-debugging.
3. Fix the root cause in its own commit, push, wait for CI again
   (`until ! gh pr checks <n> | grep -qE 'pending|queued|in_progress'; do sleep 30; done`, run in background).
4. Say plainly that a green run cannot rule out later failures while CI is still stopping early.

Seen so far: changelog untagged-release guard (every sync); `test-wall-tasks` #46 timing race in
upstream's `settle()` (fixed by polling `inflight` every turn). Offer upstream-worthy fixes to Phil;
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
