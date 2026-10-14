# R — The record format

Status: approved · 2026-10-15 · by Niko Alho

The format is the public contract ([spec section 5](spec.md#5-format-reference)). Every command reads it, so it is built first, as plain functions with unit tests, before any command uses it.

### R1 Configuration

Goal: `.resaledger.json` is read, validated and completed with its defaults, and `config` prints the result.

Design: [spec 5.2](spec.md#52-configuration). Version 2 is required; an unknown version stops the guard and names the update command. The preset fills the keys marked † in the specification, and explicit keys win. `dir` must stay inside the repository. Regular expressions are compiled once, with a clear error.

Acceptance:
- Unit tests cover every key and default, for both presets.
- Unit tests cover the failures: a missing file, invalid JSON, an unknown version, a bad regular expression and a `dir` containing `..`.
- `config` prints the effective configuration as JSON.

### R2 Markdown primitives

Goal: one small, tested layer that every record parser uses.

Design:
- Line splitting that is safe for CRLF.
- Headings and their anchors, made as GitHub makes them: 0.x's rules, with fenced code skipped and duplicates numbered.
- Sections found by anchor.
- Relative links, with decoding and `#anchor`; external links are skipped.
- Bullet fields with nested lists.
- A likely-typo check by edit distance.

Acceptance: unit tests for each part, including CRLF input, Finnish and other non-ASCII headings, duplicate headings, links with spaces and anchors, nested evidence lists and the line that ends a field list.

### R3 Task files

Goal: task files parse and validate exactly as [spec 5.3](spec.md#53-task-files) says.

Design:
- **Heading and name.** The heading is `# <id> <title>`, the id follows the format, and the file name is `<id>-<slug>.md` or `<id>.md`, agreeing with the heading.
- **Fields and sections.** Each field has its rules. The sections are `## Plan`, `## Handoff` (at most 1,500 characters) and `## Notes`.
- **A `doing` task needs a plan:** a link to a section with content, or its own Plan section. The linked plan file must not say `proposal`.
- **Evidence** needs a command in backticks, a link or a URL, and every link resolves.
- **Across all tasks:** WIP per lane, unique ids, and dependencies that exist.
- Unknown fields are kept, and likely typos are reported.

Acceptance: one unit test per rule, each with a passing and a failing case. Every error message names the file, the line and what to write instead.

### R4 Decisions, log entries, plans and the workspace README

Goal: the other record types parse and validate as the specification says: [decisions](spec.md#54-decisions), [log entries](spec.md#55-log-entries), [plans](spec.md#56-plans) and [the workspace README](spec.md#58-the-workspace-readme).

Design:
- decision fields: Date, Decided by, and Status or a superseded link
- log entry fields
- the plan status line
- the README sections and the `TODO(resaledger)` markers

Acceptance: unit tests per rule. A README that still has a marker fails the setup check, and passes once the text is written.

### R5 `check`, what counts as code, and the fingerprint

Goal: the whole workspace validates in one call, and the guard knows which files are code and what the code's fingerprint is.

Design:
- `check` collects every problem and exits non-zero when there is one.
- `isCode` follows [spec 5.10](spec.md#510-what-counts-as-code), with POSIX paths on every platform.
- The fingerprint is taken from `git ls-files -s` over the code files, so the same commit gives the same fingerprint on every operating system.

Acceptance:
- `check` runs on a valid and an invalid workspace.
- A table test covers `isCode`.
- The fingerprint is identical for one commit checked out with LF and with CRLF line endings. It changes when code, the configuration, the guard or a hook changes, and never when a record changes.
