# P5 The CI comment neutralises mentions and issue references

- Status: done
- Lane: p-guard
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p5-the-ci-comment-neutralises-mentions-and-issue-references)
- Evidence:
  - [ci-output.test.mjs](../../test/ci-output.test.mjs): the title ``Fix @alice's #12 and `@bob` `` gives `@`, `#` with a word joiner after them, and the code span unchanged; `owner/repo#7`, `GH-9` and `@org/team` too. `node --test test/ci-output.test.mjs`: 33 of 33
  - GitHub's Markdown API (`POST /markdown`, mode gfm, a public repository as context) rendered `@` and `#` followed by U+2060 or U+200B as plain text, while `\@name`, `&#64;name` and `\#1` still became a mention and an issue link

## Notes

The neutralisation is a word joiner (U+2060) after `@`, `#` and `GH` outside code spans. It is invisible and does not allow a line break; a backslash or an HTML entity does not work, since GitHub links mentions after the Markdown is rendered. Code spans would also work, but would change how the text looks. An `@` after a letter or digit, as in an address, is left alone.
