# Independent review of 1.0.0-rc.2

A second model reviewed the changes of phase P (`f2ba412..d6a3568`, `src/`, `bin/` and `.github/`) on 2026-10-15, with `npm test` at 1059 of 1059 and experiments in temporary repositories through the bundled guard. Nothing was found that blocks the release.

## Findings

| # | Area | Severity | Finding | Outcome |
| --- | --- | --- | --- | --- |
| 1 | agent hooks | medium | With `agent.pushNeedsHandoff`, `git add -A && git commit -m … && git push` is refused on a dirty tree: the check runs before the command, so before the commit, and its message asks for the commit the command was making. | [P9.1](../../tasks/P9.1-the-push-check-and-what-runs-before-it.md) |
| 2 | agent hooks | low | `git switch <lane> && git push` judges the lane the session was on before the switch. | [P9.1](../../tasks/P9.1-the-push-check-and-what-runs-before-it.md) |
| 3 | agent hooks | low | `git push --dry-run` is refused while handoff fails, though it pushes nothing. Tag pushes are refused too, which the specification's wording asks for. | Dry runs: [P9.1](../../tasks/P9.1-the-push-check-and-what-runs-before-it.md). Tags: kept as specified. |
| 4 | agent hooks | low | A push from a worktree whose HEAD has no `.resaledger.json`, a lane that branched before adoption, is refused with ".resaledger.json is missing; run npx resaledger init". Right in effect, misleading in wording. | [P9.1](../../tasks/P9.1-the-push-check-and-what-runs-before-it.md) |
| 5 | agent hooks | low | The end-of-turn reminder now judges with HEAD's configuration, so in a session where `init` ran and nothing is committed yet, the one reminder says the configuration is missing. Rare, since the hooks are not active before that commit. | Accepted. |
| 6 | typo rule | none | Nothing that passed rc.1 is refused now: the new distance is never larger, and the limits only shrink. | — |
| 7 | CI comment | low | A bare URL in evidence with a numeric fragment, `https://host/page#12`, gets the joiner after `#`, so GitHub's autolink stops there; a path with `gh-2` gets an invisible character. | [P5.1](../../tasks/P5.1-urls-and-paths-keep-their-and-gh-in-the.md) |
| 8 | migrate | low | An edited Quality gates section moves whole to the README while its manual gates are also lifted into Manual checks, so they appear twice. No line is lost, and `migrate` asks for a review of every edited section. | Accepted for rc.2. |
| 9 | init | low | A `check` script that runs the tests makes `check` and `test` both verify gates, so the tests run twice. `init` shows both gates and asks on a terminal. | Accepted. |
| 10 | release workflow | low | The npm version check fails closed if Node 24's npm is older than 11.15; installing a newer npm in the job is an alternative. | Accepted: failing with a clear message is enough, and Node 24's npm is 11.16. |

Checked and found sound: a fresh repository before its first commit, a push from another repository or a subfolder, a detached HEAD, a working tree that turns the key on while HEAD has it off, errors inside the hook (all allow), the push check in another worktree, Windows paths, the speed of the push check (about 300 ms, what `handoff` costs, no gates), the `.gitattributes` rewrite, writes within what git tracks, `- Evidence: —` as an empty value everywhere, and code spans in the CI comment.
