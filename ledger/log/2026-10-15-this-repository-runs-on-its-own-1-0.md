# 2026-10-15 · This repository runs on its own 1.0 format

- Lane: main
- Tasks: M4, W5

M4: the built `migrate` moved this repository from agent-ledger 0.3 to ResaLedger 1.0 in one commit, with no line lost, and the 1.0 guard now judges every commit here; the build is its own first user. Two tests had read the 0.x files from the working tree; they now read the last 0.x commit from history, and this repository's CI fetches the whole history so they keep running there. Migrate keeps the project's own words and rewrites only link targets, so a few links kept text that named old files; those were reworded by hand. W5 merged afterwards as the first lane into the 1.0 workspace: `changes` drafts the changelog from the tasks finished since a tag. A development guard is never a released version, so this repository renews its own with `update --force`.
