Fork sync did not both fast-forward main and publish the include-reasons branch.
Nothing was force-pushed and no branch was deleted.

Upstream main: 8f135f106a637cf76f0395f146d0417f5287046e
Fork main before this run: c6695157c3611ea85425915e4194f990f7d1046c
Patch branch: town/include-reasons-8f135f1

## Main
fast-forward push of main was rejected:
remote: error: GH013: Repository rule violations found for refs/heads/main.        
remote: Review all repository rules at https://github.com/townco/tsrs/rules?ref=refs%2Fheads%2Fmain        
remote: 
remote: - Changes must be made through a pull request.        
remote: 
To https://github.com/townco/tsrs
 ! [remote rejected]   8f135f106a637cf76f0395f146d0417f5287046e -> main (push declined due to repository rule violations)
error: failed to push some refs to 'https://github.com/townco/tsrs'

## Patch
town/include-reasons-8f135f1 already has this tree

Do not merge this pull request. It only records the failure. Regenerating the stack is documented in docs/FORK.md.

Direct pushes to main are rejected by the ruleset "Human-only default branch updates" unless a bypass actor fast-forwards it. This job does not merge upstream into main: a merge commit would end the pure fast-forward.
