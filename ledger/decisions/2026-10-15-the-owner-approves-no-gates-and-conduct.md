# The owner approves --no-gates, and conduct reports go through GitHub

- Date: 2026-10-15
- Decided by: Niko Alho
- Status: accepted

The change to spec section 13 is approved: `init --no-gates` skips detecting the gates, in place of the planned `--no-run`, which would have written checks that never ran ([the lead's decision](2026-10-15-init-keeps-only-the-checks-that-pass-as.md)). The project has no address for code-of-conduct reports, so they go to the maintainers through GitHub's private reporting form, with a title that starts "Conduct:".
