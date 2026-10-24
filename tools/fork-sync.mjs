#!/usr/bin/env node
// Fast-forward townco/tsrs main from oxc-project/tsrs and replay the include-reasons
// patch. See docs/FORK.md. Never force-pushes and never deletes branches.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstreamUrl = process.env.UPSTREAM_URL ?? "https://github.com/oxc-project/tsrs.git";
const originRemote = process.env.ORIGIN_REMOTE ?? "origin";
const repository = process.env.GITHUB_REPOSITORY ?? "townco/tsrs";
const patchPath = path.join(repoRoot, "fork", "include-reasons.patch");
const failureTitle = "Fork sync failed: include-reasons patch";
const failureBranch = "town/fork-sync-failure";
const dryRun = process.argv.includes("--dry-run");
const forceTest = process.argv.includes("--test");
let reported = false;

const redact = (text) =>
    String(text ?? "")
        .replace(/x-access-token:[^@\s]+/g, "x-access-token:[REDACTED]")
        .replace(/\b(ghp_|github_pat_|gho_)[A-Za-z0-9_]+/g, "[REDACTED]");

const clip = (text, limit = 12000) => {
    const clean = redact(text).trim();
    return clean.length <= limit ? clean : `…${clean.slice(clean.length - limit)}`;
};

function run(argv, { cwd = repoRoot, ok = false, env, input } = {}) {
    try {
        const stdout = execFileSync(argv[0], argv.slice(1), {
            cwd,
            encoding: "utf8",
            env: env ? { ...process.env, ...env } : process.env,
            input,
            maxBuffer: 64 * 1024 * 1024,
            stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
        });
        return { code: 0, stdout: stdout ?? "", stderr: "" };
    } catch (error) {
        const result = {
            code: error.status ?? 1,
            stdout: error.stdout?.toString() ?? "",
            stderr: error.stderr?.toString() || error.message || "",
        };
        if (ok) return result;
        throw new Error(`${argv.join(" ")} exited ${result.code}\n${clip(result.stdout)}\n${clip(result.stderr)}`);
    }
}

const git = (args, options) => run(["git", ...args], options);

function ensureUpstream() {
    const remotes = git(["remote"]).stdout.split("\n");
    if (!remotes.includes("upstream")) git(["remote", "add", "upstream", upstreamUrl]);
    git(["fetch", "--no-tags", "upstream", "main"]);
    git(["fetch", "--no-tags", originRemote, "main"]);
}

function fastForwardMain(upstreamSha) {
    const originMain = git(["rev-parse", `${originRemote}/main`]).stdout.trim();
    if (originMain === upstreamSha) return { originMain, detail: "fork main already matches upstream main" };
    const ancestor = git(["merge-base", "--is-ancestor", originMain, upstreamSha], { ok: true });
    if (ancestor.code !== 0) {
        const extra = git(["log", "--oneline", `${upstreamSha}..${originRemote}/main`], { ok: true });
        return {
            originMain,
            failure:
                `fork main ${originMain} is not an ancestor of upstream ${upstreamSha}; ` +
                `refusing to merge or force-push.\nCommits on fork main that are not in upstream:\n${clip(extra.stdout || extra.stderr, 4000)}`,
        };
    }
    const refspec = `${upstreamSha}:refs/heads/main`;
    if (dryRun) return { originMain, detail: `would fast-forward ${originRemote} main (${refspec})` };
    const pushed = git(["push", originRemote, refspec], { ok: true });
    if (pushed.code !== 0) {
        return {
            originMain,
            failure: `fast-forward push of main was rejected:\n${clip(`${pushed.stdout}\n${pushed.stderr}`)}`,
        };
    }
    return { originMain, detail: `fast-forwarded main to ${upstreamSha}` };
}

function replayPatch(upstreamSha) {
    const short = upstreamSha.slice(0, 7);
    const branch = `town/include-reasons-${short}`;
    const remoteRef = `refs/remotes/${originRemote}/${branch}`;
    const fetched = git(
        ["fetch", "--no-tags", originRemote, `refs/heads/${branch}:${remoteRef}`],
        { ok: true },
    );
    const branchExists = fetched.code === 0;
    const worktree = mkdtempSync(path.join(tmpdir(), "tsrs-fork-sync-"));
    try {
        git(["worktree", "add", "--detach", worktree, upstreamSha]);
        const check = git(["apply", "--check", patchPath], { cwd: worktree, ok: true });
        if (check.code !== 0) {
            return {
                branch,
                failure: `fork/include-reasons.patch does not apply onto ${upstreamSha}:\n${clip(`${check.stdout}\n${check.stderr}`)}`,
            };
        }
        git(["apply", patchPath], { cwd: worktree });
        git(["add", "-A"], { cwd: worktree });
        const tree = git(["write-tree"], { cwd: worktree }).stdout.trim();
        const upstreamTree = git(["rev-parse", `${upstreamSha}^{tree}`]).stdout.trim();
        if (tree === upstreamTree) {
            return {
                branch,
                failure: "the patch applied without changing the tree. Upstream may already provide it; not pushing a branch.",
            };
        }
        if (branchExists) {
            const existing = git(["rev-parse", `${remoteRef}^{tree}`]).stdout.trim();
            if (existing !== tree) {
                return {
                    branch,
                    failure:
                        `${branch} already exists with tree ${existing}, but the patch produces ${tree}. ` +
                        "Refusing to force-push.",
                };
            }
            if (!forceTest) return { branch, detail: `${branch} already has this tree` };
        } else if (dryRun && !forceTest) {
            return { branch, detail: `would test and push ${branch} (${tree})` };
        }
        const tested = run(
            ["cargo", "test", "--locked", "--profile", "dev", "-p", "tsrs_compiler", "--lib"],
            {
                cwd: worktree,
                ok: true,
                env: { CARGO_TARGET_DIR: path.join(repoRoot, "target") },
            },
        );
        process.stdout.write(tested.stdout);
        process.stderr.write(tested.stderr);
        if (tested.code !== 0) {
            return {
                branch,
                failure: `cargo test -p tsrs_compiler --lib failed:\n${clip(`${tested.stdout}\n${tested.stderr}`)}`,
            };
        }
        if (branchExists) return { branch, detail: `${branch} already has this tree; tests passed` };
        if (dryRun) return { branch, detail: `tests passed; would push ${branch}` };
        const message =
            "compiler: expose the kind and the referencing file of include reasons\n\n" +
            `Replay fork/include-reasons.patch onto upstream ${upstreamSha}.\n`;
        git(
            [
                "-c",
                "user.name=github-actions[bot]",
                "-c",
                "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                "commit",
                "-m",
                message,
            ],
            { cwd: worktree },
        );
        const commit = git(["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
        const pushed = git(["push", originRemote, `${commit}:refs/heads/${branch}`], { cwd: worktree, ok: true });
        if (pushed.code !== 0) {
            return {
                branch,
                failure: `push of ${branch} was rejected:\n${clip(`${pushed.stdout}\n${pushed.stderr}`)}`,
            };
        }
        return { branch, detail: `pushed ${branch} at ${commit}` };
    } finally {
        git(["worktree", "remove", "--force", worktree], { ok: true });
        rmSync(worktree, { recursive: true, force: true });
    }
}

function issueBody({ upstreamSha, mainResult, patchResult }) {
    const sections = [
        "Fork sync did not both fast-forward main and publish the include-reasons branch.",
        "Nothing was force-pushed and no branch was deleted.",
        "",
        `Upstream main: ${upstreamSha}`,
        `Fork main before this run: ${mainResult.originMain}`,
        `Patch branch: ${patchResult.branch ?? "(not computed)"}`,
        "",
        "## Main",
        mainResult.failure ?? mainResult.detail,
        "",
        "## Patch",
        patchResult.failure ?? patchResult.detail,
        "",
        "Do not merge this pull request. It only records the failure. Regenerating the stack is documented in docs/FORK.md.",
        "",
        "Direct pushes to main are rejected by the ruleset \"Human-only default branch updates\" unless a bypass actor fast-forwards it. This job does not merge upstream into main: a merge commit would end the pure fast-forward.",
    ];
    return sections.join("\n");
}

function publishFailure(body, failed) {
    if (dryRun) {
        console.log("dry-run: not updating the failure pull request");
        return;
    }
    if (reported) return;
    reported = true;
    const authed = run(["gh", "auth", "status"], { ok: true });
    if (authed.code !== 0) {
        console.log(`GitHub auth is unavailable; not updating the failure pull request\n${clip(authed.stderr, 500)}`);
        return;
    }
    const bodyFile = path.join(tmpdir(), "tsrs-fork-sync-failure.txt");
    const text = `${body.trim()}\n`;
    writeFileSync(bodyFile, text);
    try {
        if (failed) pushFailureBranch(text);
        const listed = run(
            [
                "gh",
                "pr",
                "list",
                "--repo",
                repository,
                "--head",
                failureBranch,
                "--state",
                "all",
                "--json",
                "number,state,title",
            ],
            { ok: true },
        );
        if (listed.code !== 0) throw new Error(`could not list pull requests\n${clip(listed.stderr)}`);
        const match = JSON.parse(listed.stdout || "[]").find((pr) => pr.title === failureTitle);
        if (!failed) {
            if (match?.state === "OPEN") {
                run(["gh", "pr", "close", String(match.number), "--repo", repository, "--comment", text]);
                console.log(`closed pull request #${match.number}`);
            }
            return;
        }
        if (!match) {
            const created = run(
                [
                    "gh",
                    "pr",
                    "create",
                    "--repo",
                    repository,
                    "--base",
                    "main",
                    "--head",
                    failureBranch,
                    "--draft",
                    "--title",
                    failureTitle,
                    "--body-file",
                    bodyFile,
                ],
                { ok: true },
            );
            if (created.code !== 0) {
                console.error(`could not open the failure pull request:\n${clip(created.stderr)}`);
                return;
            }
            console.log(created.stdout.trim());
            return;
        }
        const current = run([
            "gh",
            "pr",
            "view",
            String(match.number),
            "--repo",
            repository,
            "--json",
            "body",
            "--jq",
            ".body",
        ]).stdout.trim();
        if (current !== text.trim()) {
            run(["gh", "pr", "edit", String(match.number), "--repo", repository, "--body-file", bodyFile]);
            console.log(`updated pull request #${match.number}`);
        } else {
            console.log(`pull request #${match.number} already describes this failure`);
        }
        if (match.state !== "OPEN") {
            run(["gh", "pr", "reopen", String(match.number), "--repo", repository]);
        }
    } finally {
        rmSync(bodyFile, { force: true });
    }
}

function pushFailureBranch(text) {
    const remoteRef = `refs/remotes/${originRemote}/${failureBranch}`;
    const fetched = git(
        ["fetch", "--no-tags", originRemote, `refs/heads/${failureBranch}:${remoteRef}`],
        { ok: true },
    );
    const worktree = mkdtempSync(path.join(tmpdir(), "tsrs-fork-sync-failure-"));
    try {
        if (fetched.code === 0) git(["worktree", "add", "--detach", worktree, remoteRef]);
        else git(["worktree", "add", "--detach", worktree, `${originRemote}/main`]);
        const file = path.join(worktree, "fork", "sync-failure.md");
        mkdirSync(path.dirname(file), { recursive: true });
        if (existsSync(file) && readFileSync(file, "utf8") === text) return;
        writeFileSync(file, text);
        git(["add", "fork/sync-failure.md"], { cwd: worktree });
        git(
            [
                "-c",
                "user.name=github-actions[bot]",
                "-c",
                "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                "commit",
                "-m",
                "fork: record include-reasons sync failure",
            ],
            { cwd: worktree },
        );
        const commit = git(["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
        const pushed = git(["push", originRemote, `${commit}:refs/heads/${failureBranch}`], {
            cwd: worktree,
            ok: true,
        });
        if (pushed.code !== 0) {
            throw new Error(`push of ${failureBranch} was rejected:\n${clip(`${pushed.stdout}\n${pushed.stderr}`)}`);
        }
    } finally {
        git(["worktree", "remove", "--force", worktree], { ok: true });
        rmSync(worktree, { recursive: true, force: true });
    }
}

function main() {
    if (!readFileSync(patchPath, "utf8").startsWith("diff --git ")) {
        throw new Error(`${patchPath} is not a git diff`);
    }
    ensureUpstream();
    const upstreamSha = git(["rev-parse", "upstream/main"]).stdout.trim();
    const mainResult = fastForwardMain(upstreamSha);
    const patchResult = replayPatch(upstreamSha);
    const failed = Boolean(mainResult.failure || patchResult.failure);
    console.log(mainResult.failure ?? mainResult.detail);
    console.log(patchResult.failure ?? patchResult.detail);
    if (failed) publishFailure(issueBody({ upstreamSha, mainResult, patchResult }), true);
    else {
        publishFailure(
            `Sync succeeded for upstream ${upstreamSha}.\n\n${mainResult.detail}\n${patchResult.detail}`,
            false,
        );
    }
    if (failed) process.exitCode = 1;
}

try {
    main();
} catch (error) {
    const text = redact(error.stack || error.message);
    console.error(text);
    try {
        publishFailure(`Fork sync crashed before it could finish.\n\n${clip(text)}`, true);
    } catch (issueError) {
        console.error(redact(issueError.message));
    }
    process.exitCode = 1;
}
