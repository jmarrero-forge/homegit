---
verdict: human-text
ai-trailer: default (Generated-by: AI); libdnf says nothing, but 7 of the last 100 commits on dnf-4-master carry Assisted-by, and the sibling dnf5 CONTRIBUTING.md (same maintainers) requires "Assisted-by: <name of AI tool>", so Assisted-by is the better fit here
dco: no (dnf-4-master has no branch rules and its protection requires no status checks; no DCO check on its head or on the 6 recent PR heads sampled, which run only Packit builds and Testing Farm)
sources:
  - repo: rpm-software-management/libdnf
    path: README.md
    sha: bdddb0c66ff3f94a241bca5f286f7094aa525d3e
  - repo: rpm-software-management/libdnf
    path: .git-commit-template
    sha: 23b740668557a295a9c6023abd4aee2a97001522
  - repo: rpm-software-management/libdnf
    path: AUTHORS
    sha: 809374cdf0e53f121b508a33cda26ff03484e4a6
  - repo: rpm-software-management/dnf5
    path: CONTRIBUTING.md
    sha: 6d5e17016e1c23b6e87112f8baea2540ebb0be1f
checked: 2026-11-05 by the policy-check subagent (coordinator session 77cad178, for coreos/rpm-ostree#5566)
---

`bin/upstream-policy scan` finds nothing: libdnf has no CONTRIBUTING,
AGENTS.md, AI policy, PR template or DCO file, and the org has no
`rpm-software-management/.github` repository. The default branch is
dnf-4-master (there is no main), which is also the branch the pending
PR targets, so there is only one set of rules to check. The only
contribution rules are in the README; `.git-commit-template` is the
optional changelog block it points to. The dnf5 CONTRIBUTING.md is not
linked from libdnf; it is recorded as context because it is the same
team's written AI policy.

## Quotes

> "Here's the most direct way to get your work merged into the project.
>
> 1. Fork the project
> 1. Clone down your fork
> 1. Implement your feature or bug fix and commit changes
> 1. If the change fixes a bug at [Red Hat bugzilla](https://bugzilla.redhat.com/), or if it is important to the end user, add the following block to the commit message:
>
>        = changelog =
>        msg:           message to be included in the changelog
>        type:          one of: bugfix/enhancement/security (this field is required when message is present)
>        resolves:      URLs to bugs or issues resolved by this commit (can be specified multiple times)
>        related:       URLs to any related bugs or issues (can be specified multiple times)"
> — rpm-software-management/libdnf README.md (bdddb0c66ff3), "Contribution"

> "In a separate commit, add your name and email under ``Libdnf CONTRIBUTORS`` section in the [authors file](https://github.com/rpm-software-management/libdnf/blob/dnf-4-master/README.md) as a reward for your generosity"
> — rpm-software-management/libdnf README.md (bdddb0c66ff3), "Contribution"

> "Please do not create pull requests with translation (.po) file improvements. Fix the translation on `Fedora Weblate <https://translate.fedoraproject.org/projects/dnf/>`_ instead."
> — rpm-software-management/libdnf README.md (bdddb0c66ff3), "Contribution"

> "**Note that DNF4 and libdnf are superseded by [DNF5 and libdnf5](https://github.com/rpm-software-management/dnf5). DNF5 is the default package manager in Fedora as of Fedora 41. New projects should integrate with libdnf5 instead.**"
> — rpm-software-management/libdnf README.md (bdddb0c66ff3), top

Nothing in libdnf mentions AI, bots, sign-off or PR descriptions. For
context, the sibling project's policy (not referenced from libdnf):

> "You **MAY** use AI assistance for contributing to this project, as long as you follow the principles described below."
> — rpm-software-management/dnf5 CONTRIBUTING.md (6d5e17016e1c), "AI-assisted contributions policy"

> "The contributor is always the author and is fully accountable for the entirety of these contributions."
> — rpm-software-management/dnf5 CONTRIBUTING.md (6d5e17016e1c), "AI-assisted contributions policy", 1. Accountability

> "You **MUST** disclose the use of AI tools when the significant part of the contribution is taken from a tool without changes. You **MUST** use an `Assisted-by: <name of AI tool>` line at the end of your git commit messages to do so, for example:
>
>   * `Assisted-by: generic LLM chatbot`
>
>   * `Assisted-by: ChatGPTv5`
>
> You **SHOULD** disclose the other uses of AI tools, where it might be useful."
> — rpm-software-management/dnf5 CONTRIBUTING.md (6d5e17016e1c), "AI-assisted contributions policy", 2. Transparency

## Rationale

The verdict comes from silence: libdnf's own files say nothing about AI,
bots or who writes PR text, so it stays human-text until the operator
decides otherwise. It is not bot-ok because nothing in libdnf explicitly
allows AI-assisted contributions; dnf5's "MAY use AI assistance" policy
(adapted from the Fedora Council's) and recent `Assisted-by: Kiro` /
`Assisted-by: Claude Opus 4.6` commits on dnf-4-master suggest the same
maintainers would accept it, which is the case for loosening, but that
policy lives in another repository that libdnf does not point to. Two
practical notes for whoever writes the PR: the README asks contributors
to add themselves to AUTHORS in a separate commit, which is the
operator's call and not the bot's; and the optional `= changelog =`
block belongs in the commit message for user-visible fixes.
