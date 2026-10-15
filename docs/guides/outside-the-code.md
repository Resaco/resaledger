# Work outside the code

Some work never reaches a commit: a page edited in a content management system, a setting changed on a server, a record fixed with a database's command-line tool. This guide records that work in the same ledger as the code, and says what ResaLedger enforces there and what it does not.

The examples continue the bakery shop from [Working alone](solo.md), with ResaLedger set up and the gates verified. The shop's pages live in a CMS on a server; the repository holds the theme and the ledger.

## What the ledger does here

The git hooks and CI see commits. They do not see a database or a server, so nothing refuses a page that was edited without a task. For this work the ledger keeps the record: what was planned, who did it, what proves it, and what is left for the next session. The protocol in `AGENTS.md` is the same, because the task, the claim and the handoff are the same; only the evidence differs.

When agents do this kind of work, say so in the project's own part of `AGENTS.md`, for example: "Content and server changes are tasks too: claim the task before you change anything, and record its evidence."

## Plan and claim

A task for content work looks like any other. Its plan says what a person can check when it is done:

```bash
node ledger/scripts/records.mjs new "Post the holiday opening hours"
cat >> ledger/tasks/T1-post-the-holiday-opening-hours.md <<'EOF'

## Plan

Change the opening hours page in the CMS for the holidays. Done when https://bakery.example/hours shows the holiday hours in a browser.
EOF
node ledger/scripts/records.mjs claim T1
```

```text
✔ created ledger/tasks/T1-post-the-holiday-opening-hours.md
✔ T1 claimed in lane main
```

## Do the work

The change itself happens outside the repository, for example over SSH with the CMS's command-line tool:

<!-- not run: changes a page on a server -->

```bash
ssh shop.example wp post update 42 holiday-hours.html
```

```text
Success: Updated post 42.
```

If the same task also changes code, such as the theme, commit that code with `Task: T1` and run `verify` as usual.

## Record the evidence

Evidence lets someone else believe the work is done without redoing it. For work outside the code, choose what another person can check:

- a screenshot of the result under `ledger/evidence/`;
- the address of the changed page;
- a revision or version id that the system shows;
- the command and what it printed.

Keep a screenshot small: crop it to the change and save it as WebP or PNG. Leave out personal data, such as customers' names in an order list, because git keeps every version of every file. Images and text files in `ledger/evidence/` are records, not code, so committing them needs no task and keeps the stamp valid.

<!-- not run: needs the screenshot and the cwebp tool; stand-in: mkdir -p ledger/evidence/T1 && printf 'RIFF' > ledger/evidence/T1/holiday-hours.webp -->

```bash
mkdir -p ledger/evidence/T1 && cwebp -q 70 -resize 1200 0 holiday-hours.png -o ledger/evidence/T1/holiday-hours.webp
```

Then finish the task with that evidence, and hand off:

```bash
cat > ledger/tasks/T1-post-the-holiday-opening-hours.md <<'EOF'
# T1 Post the holiday opening hours

- Status: done
- Lane: main
- Evidence:
  - https://bakery.example/hours shows the holiday hours: [screenshot](../evidence/T1/holiday-hours.webp)
  - `ssh shop.example wp post update 42 holiday-hours.html`: Success: Updated post 42.
  - Not verified: the page on a phone.

## Plan

Change the opening hours page in the CMS for the holidays. Done when https://bakery.example/hours shows the holiday hours in a browser.
EOF
git add ledger
git commit -m "docs: finish T1, the holiday opening hours" -m "Task: T1"
node ledger/scripts/records.mjs handoff
```

```text
✔ handed off: records valid, the gates passed on this code, every task in progress has a current handoff note
```

## Documents outside the repository

Every relative link in the records must resolve inside the repository, so `check` refuses a link to a file elsewhere, such as a brief in a shared drive. Give such a document by its URL, or name it in a code span when it has none: ``Brief: `Shared drive / Bakery / Holiday campaign` ``. Write what an agent needs in order to act into a plan in `ledger/plan/`, so the next session finds it in the repository.
