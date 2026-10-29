# Fork

`townco/tsrs` is a fork of [oxc-project/tsrs](https://github.com/oxc-project/tsrs) (the repository
previously published as `maschwenk/tsrs`). It is a patch stack on upstream `main`, not a second
history of upstream.

Two refs, with different jobs:

| Ref | What it is |
| --- | --- |
| `main` | The default branch and the control branch. It holds this document, `fork/patches.txt`, `tools/fork-sync.mjs`, and `.github/workflows/fork-sync.yml`. It does not track upstream commit-for-commit. |
| `town/patched` | The one moving branch consumers build. Each sync rebuilds it as upstream `main` plus the commits in `fork/patches.txt`. |

`main` is already the default branch. Nothing in the sync changes that setting or the ruleset
"Human-only default branch updates". Scheduled workflows run from the default branch, so the
workflow file has to be on `main`. The job never pushes `main`, so it never needs a bypass of
that ruleset and it never needs a human to fast-forward `main`.

## The stack

`fork/patches.txt` is the stack: full commit SHAs, cherry-picked in order. The sync does not use
`git apply`.

The current commit makes `FileIncludeReason::kind` and `FileIncludeReason::referencing_file`
public, re-exports `FileIncludeKind`, and keeps the pre-#743 name `fileIncludeKind` as a type
alias. `townco/town`'s graph context imports that alias. Upstream `0d3458e53f914d91865be4a838b4c15464ecfc61`
(`#761`) narrowed field visibility and did not add those accessors, so the commit stays. Upstream
`811d21478f7f4bffac49a93f172a5091735f6540` (`#797`) builds no unit-test harness and lints against tests in
`src`, so the commit's test is `crates/tsrs_compiler/tests/integration/file_include_test.rs`.

These older branches are the same change on older bases. Do not delete them and do not
force-push them. `townco/town` has pinned `f502bb63865ae942cb109b46c70079cbcc56d9a6`.

| Branch | Commit | Base |
| --- | --- | --- |
| `town/include-reasons` | `8d5c0a5e9337a33be4c1386065140cb7e0a5ade4` | `034373ca` (`#295`) |
| `town/include-reasons-0.18` | `f502bb63865ae942cb109b46c70079cbcc56d9a6` | `v0.18.0` (`5f92808b`) |
| `town/include-reasons-c669515` | `a161962970e149b4de0615dd29d4a31cabc90b23` | `c6695157` |
| `town/include-reasons-8f135f1` | `4c2e40b6df8baeb657a2cd43eec7b17a79c61086` | `8f135f106` |

`746443969258121122ef25c8886f02c4ec0062a2` is the source commit in `fork/patches.txt`, on base
`dc4ea354`. It is `4c2e40b6` with the inline unit test moved to the integration binary. The tag
`fork-backup-746443969258121122ef25c8886f02c4ec0062a2` points at it, and
`fork-backup-4c2e40b6df8baeb657a2cd43eec7b17a79c61086` still points at the previous source.
`town/patched` is the replay of the source commit onto current upstream `main`, not a new patch.

## What the daily job does

`.github/workflows/fork-sync.yml` runs `node tools/fork-sync.mjs` at 03:00
`America/Los_Angeles`, and on manual dispatch, only in `townco/tsrs`:

1. Require the Actions secret `FORK_PUSH_TOKEN`. If it is missing, stop with that stated and do
   not push `town/patched`. The job does not fall back to `GITHUB_TOKEN` for that push.
2. Fetch upstream `main` and the commits named in `fork/patches.txt`.
3. In a temporary worktree at upstream `main`, `git cherry-pick -x` each commit. A commit already
   in upstream history, or whose cherry-pick is empty, is dropped and is not committed again. A
   conflict aborts the replay. Nothing is pushed, and `town/patched` stays at its previous tip.
4. If `town/patched` already has the replayed tree, stop. The same tree is not given a new SHA.
5. Otherwise run, in the worktree, with the toolchain in that tree's `rust-toolchain.toml`:
   `cargo fmt --all --check`,
   `cargo clippy --locked --all-targets --workspace` with warnings denied,
   and `cargo check --locked --workspace --all-targets` with warnings denied.
   `cargo test --profile ci --locked --workspace` with warnings denied (upstream CI's command:
   a debug build misses the wall-time budgets of the `tsrs_api` integration tests) then runs
   with Node at the major version in that
   tree's `.node-version` and with `microsoft/TypeScript` checked out at the
   `workspace.metadata.typescript` commit, sparse, into `ts-ref` (the same paths CI
   uses: `tsc/testdata`, `packages/typescript/{src,lib,vendor}`, `tools/scripts/tsc`).
   The workspace tests fail, rather than skip, when that checkout is missing.
   Any failure stops the job before the push.
6. Tag the previous `town/patched` tip as `fork-backup-<40-character sha>` (lightweight, not
   force-moved). Then `git push --force-with-lease` the new tip to `town/patched`. A lost race
   leaves the previous tip in place.

A failed run opens or updates one draft pull request, `Fork sync failed`, from
`town/fork-sync-failure`. This repository has GitHub issues disabled. The pull request records
the failure. Do not merge it. A later successful run closes it. `GITHUB_TOKEN` can push that
branch and edit the pull request; that path does not need `FORK_PUSH_TOKEN`.

`node tools/fork-sync.mjs --dry-run` fetches and cherry-picks without the secret, without gates,
and without pushing. `--dry-run --test` also runs the gates.

## Push token

Create the repository Actions secret `FORK_PUSH_TOKEN` by hand. Do not put the token in the
repository, and do not grant it a bypass of "Human-only default branch updates".

The token is a fine-grained personal access token (or a GitHub App installation token) whose
repository access is only `townco/tsrs`, with Contents read and write. Metadata read is
required by GitHub. Workflows permission is not required: `town/patched` is produced by
cherry-pick of the listed commits and the job never pushes workflow files. The built-in
`GITHUB_TOKEN` is not used for this push because a later patch that touches
`.github/workflows` cannot be pushed with it, and a silent fallback is how a sync looks green
while the branch does not move.

## Changing the stack

Cherry-pick the current source onto a fresh upstream `main`, edit, and commit. Push that commit
so it stays reachable (a branch or a `fork-backup-*` tag). Replace the line in `fork/patches.txt`
with the new full SHA, in a pull request to `main`. The next sync cherry-picks that SHA. Until
the pull request is merged, the scheduled job still replays the previous list.

When the job logs that a SHA was dropped, delete that line in a pull request to `main`. Leaving
it in the list is harmless: the next run drops it again and still replays the others.

## Why the consumable branch is not `main`

The maintained branches of `gkze/opencode` and `gkze/opencodex` are themselves the rebased
upstream history. When that replay fails, the branch people build falls behind upstream and
stays there until the sync is repaired. This fork keeps the control files on `main` and rebuilds
`town/patched` from current upstream on every run, so a control commit that is not in upstream
does not have to be fast-forwarded, merged, or force-pushed onto `main`. A conflict does not
create a merge commit and does not move `town/patched`.

Backup tags are not deleted by the job. Restoring a previous tip is `git push --force-with-lease`
of that tag back to `town/patched`, done deliberately, not by the schedule.
