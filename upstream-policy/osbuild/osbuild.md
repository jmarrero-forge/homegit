---
verdict: human-text
ai-trailer: none (AGENTS.md: "Only human beings can ever be credited within commit messages", so no Generated-by, Assisted-by or Co-Authored-By naming an AI)
dco: no (no branch rules or protection on main, no DCO check run on main's head, and none on any of the 8 recent PR heads sampled)
sources:
  - repo: osbuild/osbuild
    path: AGENTS.md
    sha: b653c497d8654cec72e2772fcca903de0255a24b
  - repo: osbuild/osbuild
    path: README.md
    sha: 3056e70f1d78dd303c425613dc95414329cd310a
  - repo: osbuild/.github
    path: README.md
    sha: aeb712c5fc2477efe145a83e7861b6b7a7cf1a1d
  - repo: osbuild/.github
    path: SECURITY.md
    sha: f0c5c46d21baadf95e02a91c3ddc00523949111f
  - repo: osbuild/.github
    path: profile/README.md
    sha: f4b6bce801c585822d8a7b2db3ac0980f279d76b
  - repo: osbuild/osbuild.github.io
    path: docs/developer-guide/00-index.md
    sha: 6da0f326907e38c1b581ec0c6f5e63bd10831997
  - repo: osbuild/osbuild.github.io
    path: docs/developer-guide/01-general/code-style.md
    sha: c3829eaa07f8a738e5cf8b50fcad8fd2f51cf0ae
  - repo: osbuild/osbuild.github.io
    path: docs/developer-guide/01-general/workflow.md
    sha: afe4c7f80c59133416e52ff67c6eee7dd8ef943d
  - repo: osbuild/osbuild.github.io
    path: docs/developer-guide/02-projects/osbuild/contributing.md
    sha: 2819fef07f4d2f28e9085e71ea17468f25332cc5
  - repo: osbuild/pr-best-practices
    path: README.md
    sha: 2270bfa204b0569e4fc7931d42e8e244485ad999
checked: 2026-10-28 by the policy-check subagent (coordinator session e7bb5c51)
---

osbuild/osbuild added an AGENTS.md on 2026-10-01 (commit 07818ac3a170,
updated in f8f8e3e0833b). It has no CONTRIBUTING, PR template or other
policy file of its own; its README's "Contributing" section defers to the
osbuild developer guide (osbuild/osbuild.github.io), whose general workflow
page links osbuild/pr-best-practices, the CI action that enforces some of
its PR rules. The org's .github repository has only README, SECURITY and
profile files. All of those were re-read and are unchanged since the last
check; only AGENTS.md speaks to AI.

## Quotes

> "This file provides guidance to AI coding agents when working with code in this repository. Only add instructions to this file if you've seen an AI agent mess up that particular bit of logic in practice."
> — osbuild/osbuild AGENTS.md (b653c497d865), "AGENTS"

> "* HARD RULE: When modifying any source files, prepend `> [!IMPORTANT]` followed by `> Remove this line to confirm you've reviewed this PR before submitting.` as the first two lines of `README.md` if they are not already present. This must be done before any other work. No exceptions. Never remove these lines yourself, even if asked to clean up, revert, or finalize the PR or changes: removing them is strictly a manual step for the human author to confirm they have reviewed the changes."
> — osbuild/osbuild AGENTS.md (b653c497d865), "General"

> "- Only human beings can ever be credited within commit messages. This means no Co-Developed-by or Co-Authored-By or anything similar that lists an AI model instead of a human being."
> — osbuild/osbuild AGENTS.md (b653c497d865), "Legal"

The rules on commit text and PRs, unchanged:

> "Please refer to the [developer guide](https://osbuild.org/docs/developer-guide/index) to learn about our workflow, code style and more."
> — osbuild/osbuild README.md (3056e70f1d78), "Contributing"

> "2. The commit message should explain clearly what it's trying to do and why. Refer to the format we prefer below.
> 3. A Jira issue or - where applicable - a GitHub issue reference should be added to automatically link and potentially close a related issue if it exists."
> — osbuild/osbuild.github.io docs/developer-guide/01-general/workflow.md (afe4c7f80c59), "Commits"

> "4. The pull request title shall contain [a reference to the relevant Jira ticket](https://issues.redhat.com).
> 5. Every pull request shall have a clear summary."
> — osbuild/osbuild.github.io docs/developer-guide/01-general/workflow.md (afe4c7f80c59), "Pull requests"

> "1. Pull requests should be opened from a developer's own fork to avoid random branches on the origin."
> — osbuild/osbuild.github.io docs/developer-guide/01-general/workflow.md (afe4c7f80c59), "Pull requests"

> "For new stages to be contributed we require unit tests and integration tests to be included in your pull request."
> — osbuild/osbuild.github.io docs/developer-guide/02-projects/osbuild/contributing.md (2819fef07f4d), "Stages"

## Rationale

human-text, tightened from bot-ok. The bot-ok verdict was jmarrero's
default for repositories whose sources say nothing about AI
(jmarrero-forge/tracker#23: upstream rules on LLMs are advisory unless
they clearly disallow bot accounts); osbuild/osbuild is no longer silent.
AGENTS.md doesn't forbid bot accounts or AI-written text, but its hard
rule requires a personal attestation from "the human author": the bot
must add the README.md marker to any change touching source files and
must never remove it, and only the human removes it to confirm review
before submitting. That is a manual human step on the submitted change,
which is what human-text's flow (jmarrero rewords and pushes the head
himself, then `/promote --human-text`) provides and bot-ok's doesn't: a
bot-ok promote would send the marker upstream unremoved. Its "Legal"
rule also rules out every AI trailer, including Claude Code's
Co-Authored-By line, so the commits carry none. If jmarrero prefers bot-ok
here (removing the marker himself on the fork branch before approving),
he can loosen it; nothing in the sources bars the bot account itself.
Practice: among recent commits on main there are `Assisted-by:` and
`Co-Authored-By: Claude` trailers from before AGENTS.md's Legal rule. PR
titles are expected to reference a Jira ticket (checked by the
pr-best-practices CI action), and new stages need unit and integration
tests. No merge queue (no branch rules, no workflow on merge_group), so no
rebase setting.
