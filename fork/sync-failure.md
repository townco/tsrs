Fork sync crashed before it could finish.

Error: gh pr create --repo townco/tsrs --base main --head town/fork-sync-failure --draft --title Fork sync failed: include-reasons patch --body-file /tmp/tsrs-fork-sync-failure.txt exited 1

pull request create failed: GraphQL: Resource not accessible by integration (createPullRequest)
    at run (file:///workspace/tools/fork-sync.mjs:48:15)
    at publishFailure (file:///workspace/tools/fork-sync.mjs:240:29)
    at main (file:///workspace/tools/fork-sync.mjs:337:17)
    at file:///workspace/tools/fork-sync.mjs:348:5
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:681:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)
