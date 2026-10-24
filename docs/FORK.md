# Fork sync

`townco/tsrs` tracks [oxc-project/tsrs](https://github.com/oxc-project/tsrs). `main` is a mirror of
upstream `main` and is updated only by fast-forward. The town patch stack is one commit, replayed
onto each new upstream `main` as `town/include-reasons-<7 hex digits of upstream>`.

## The stack

`fork/include-reasons.patch` is the whole stack. It makes `FileIncludeReason::kind` and
`FileIncludeReason::referencing_file` public, re-exports `FileIncludeKind`, and keeps the pre-#743
name `fileIncludeKind` as a type alias. `townco/town`'s graph context imports that alias.

These three branches are that same change on different bases. Do not delete them.
`townco/town` pins `f502bb63865ae942cb109b46c70079cbcc56d9a6`.

| Branch | Commit | Base |
| --- | --- | --- |
| `town/include-reasons` | `8d5c0a5e9337a33be4c1386065140cb7e0a5ade4` | `034373ca` (`#295`) |
| `town/include-reasons-0.18` | `f502bb63865ae942cb109b46c70079cbcc56d9a6` | `v0.18.0` (`5f92808b`) |
| `town/include-reasons-c669515` | `a161962970e149b4de0615dd29d4a31cabc90b23` | `c6695157` |

The patch was regenerated against upstream `8f135f106a637cf76f0395f146d0417f5287046e`. Upstream
renamed `fileIncludeKind` to `FileIncludeKind` in `2fc76e34` (`#743`) and still leaves the reason
fields crate-private, so the accessors stayed. Nothing from the stack was dropped.

## What the daily job does

`.github/workflows/fork-sync.yml` runs `node tools/fork-sync.mjs`:

1. Fetch `oxc-project/tsrs` `main`.
2. Fast-forward fork `main` when it is an ancestor of upstream. A rejected push, or a main that is
   not an ancestor, is a failure. The job does not merge and does not force-push.
3. Apply `fork/include-reasons.patch` onto upstream `main` in a temporary worktree.
4. If `town/include-reasons-<sha>` already exists with that tree, stop. If it exists with a
   different tree, stop without pushing. Otherwise run `cargo test --locked --profile dev -p
   tsrs_compiler --lib` and push the branch.
5. On failure, open or update one draft pull request titled `Fork sync failed:
   include-reasons patch` from `town/fork-sync-failure`. townco/tsrs has GitHub
   issues disabled. A later successful run closes that pull request. The same
   failure text is not pushed again. Do not merge the pull request.

The ruleset "Human-only default branch updates" rejects direct pushes to `main`, including a pure
fast-forward. A bypass actor has to push that fast-forward. Merging this workflow onto `main` also
ends the pure fast-forward, because upstream will not contain the workflow commit. Fast-forward
`main` to upstream before merging this change if the mirror should move first.

## Regenerating by hand

From a checkout that already has `fork/include-reasons.patch`:

```sh
git fetch https://github.com/oxc-project/tsrs.git main
git worktree add --detach /tmp/tsrs-replay FETCH_HEAD
git -C /tmp/tsrs-replay apply "$PWD/fork/include-reasons.patch"
cargo test --locked --profile dev -p tsrs_compiler --lib --manifest-path /tmp/tsrs-replay/Cargo.toml
```

Commit on that worktree and push `town/include-reasons-` plus the first 7 hex digits of `FETCH_HEAD`.
To change the stack, edit the worktree, commit, and replace `fork/include-reasons.patch` with
`git diff <upstream> <that commit> -- crates/tsrs_compiler`.

`node tools/fork-sync.mjs --dry-run` fetches, checks the fast-forward, and applies the patch without
pushing or editing issues. `--dry-run --test` also runs the compiler tests.
