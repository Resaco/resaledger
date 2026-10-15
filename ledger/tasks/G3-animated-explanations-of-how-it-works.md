# G3 Animated explanations of how it works

- Status: done
- Depends on: G2
- Plan: [G-brand.md](../plan/G-brand.md#g3-animated-explanations-of-how-it-works)
- Evidence: [how-it-works.test.mjs](../../test/how-it-works.test.mjs) passes on [the two files](../../docs/assets/how-it-works/how-it-works-dark.svg): each is under 75 KB, runs no script, loads nothing from outside and has a still frame for reduced motion. The lead stepped through the loop frame by frame in Chromium; the storyboard's six beats are there.

## Notes

The owner chose one loop over three and saw it play in the README on GitHub on 15 October. Not checked: Firefox and Safari. The generator stays with the private brand files, as G2's tools do.
