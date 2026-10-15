# V1 Gates and stamps

- Status: done
- Depends on: R5
- Plan: [V-verify.md](../plan/V-verify.md#v1-gates-and-stamps)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 268 of 268 on Node 24.18.0, 22.23.3 and 20.20.2 (with W1's verification state); the 23 tests in [gates.test.mjs](../../test/gates.test.mjs) include two branches verifying the same code and a new stamp against a pruned one, merged in both orders with ten long gates. Not verified: Windows shells (CI).

## Notes

The stamp's gate list is a digest bound to the fingerprint, so no two stamps look like a rename to git. `work` now says whether the gates passed on the code at HEAD.
