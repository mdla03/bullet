# Git hooks

Reference copies of the hooks this repo relies on. Git never installs hooks
from a clone, by design, so these are not active until you copy them in:

```sh
cp .githooks/* "$(git rev-parse --git-common-dir)/hooks/"
chmod +x "$(git rev-parse --git-common-dir)/hooks/"*
```

`--git-common-dir` rather than `--git-dir` because this repo uses worktrees,
which share one hooks directory. Installing once covers all of them.

## commit-msg

Strips AI attribution trailers (`Co-Authored-By: Claude`, `Generated with
[Claude Code]`) from every commit message. Human co-authors are kept, and
prose mentioning Claude in the body survives.

Losing this one is quiet: commits simply start carrying the trailer again.

## pre-commit

Refuses direct commits to master. Feature work goes on a branch and reaches
master through a merge.

This exists because two worktrees share this repo, `bullet` on master and
`bullet-d1` on a feature branch, and it is easy to run git in the wrong one.
A commit meant for a branch has landed on master more than once.

Merges pass through. For a deliberate master commit:

```sh
ALLOW_MASTER_COMMIT=1 git commit ...
```

## Why not core.hooksPath

Setting `core.hooksPath` to this directory would work, but it replaces the
whole hooks directory, so both guards would then depend on one config flag
being set in every clone. The copy above is one command and has no such
coupling. It also keeps the master-block opt-in: it guards a two-worktree
hazard that other clones do not have.
