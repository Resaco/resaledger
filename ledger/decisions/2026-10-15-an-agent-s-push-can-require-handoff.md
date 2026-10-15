# An agent's push can require handoff, short names allow one letter of typo, and check is a gate

- Date: 2026-10-15
- Decided by: Niko Alho
- Status: accepted

Three changes to the specification for 1.0.0-rc.2, from the first adoptions of rc.1. The tasks are in [phase P](../plan/P-adoption-feedback.md).

1. **`agent.pushNeedsHandoff`**, a new configuration key, `false` by default. With `true`, the agent hooks refuse an agent's `git push` while `handoff` fails, so an agent does not push work it has not handed over. The check leaves out handoff's requirement that the lane is pushed, which the push itself fulfils. It lives in the agent hook and not in git's pre-push hook: the agent hook knows its caller is an agent, while pre-push would have to guess from environment variables that differ from agent to agent. An agent without hooks is not covered, and git hooks and CI still hold. A project that adds the same check to its pre-push by hand turns the hook into a hand-edited file that `update` no longer renews; the key replaces that edit.
2. **The typo distance depends on the length of the known name.** A field or configuration key within two letters of a known name of six letters or more, or within one letter of a shorter one, is a likely typo. Two letters is half of a four-letter name: a free field `Later` was refused as a typo of `Lane`, and a configuration key `id` as a typo of `dir`. The specification's example, `Staus`, is still caught.
3. **`package.json`'s `check` script is a `verify` candidate**, as the Makefile's `check` target already is. Other scripts are not run, because a name does not say whether a script ends or changes files (`test:watch`, `lint:fix`). `init` lists the scripts whose names start with `test:` or `lint:`, so that the project can add them by hand.
