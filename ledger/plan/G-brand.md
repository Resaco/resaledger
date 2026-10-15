# G — Brand and graphics

Status: approved · 2026-10-15 · by Niko Alho

The identity and the graphics the repository shows: the logo, the cover image, and the animated explanations of how ResaLedger works.

### G1 Brand concepts

Goal: three concept directions for the ResaLedger identity, from which the owner picks one.

Current state: the name is decided. The Resa product family shares one custom lettering for "Resa" and an endorsement line; each product has its own mark, palette, typeface and graphic device, and keeps clear of its siblings' colours and fonts.

Design: each direction shows a mark, the wordmark lockup, a cover image sketch and a sample of the diagram style, in a dark graffiti style with a refined grain. The working files stay outside this repository, because they contain the family's lettering sources; only exports the owner approves come in, in G2.

Acceptance:
- one comparison sheet the owner can judge at a glance, with the three directions labelled;
- every direction uses the family's "Resa" letters unchanged and draws the rest to the same measurements;
- no sibling colour or typeface; text contrast measured, at least 4.5:1;
- the grain reads as texture at full size and does not turn into noise at 64 px.

Risks: graffiti can tip into noise. Each direction keeps one strong object.

### G2 Final logo and cover

Goal: the chosen direction (C1, parallel ruled lanes), finished and exported into the repository: the logo files, the README cover and the social preview, in light and dark variants where the README needs them.

Design:
- **The mark** is three equal lanes, truly parallel through the 45° turn. The master uses clean vector curves; the bowls of `d` and `g` are redrawn as real curves rather than sampled outlines. The 16, 32 and 64 px versions are fitted to the pixel grid.
- **The lockups** are horizontal, on dark and on light, each with and without "by Resaco".
- **The cover** is 1280×640: a dark wall with the mark in bone white, plus a light variant. The same image serves as GitHub's social preview.
- **Surface treatment:** grain only, as a still texture, and a clean stencil edge. There is no spray, overspray or drip anywhere (the owner's decision).
- **Palette:**
  - asphalt `#111110`
  - wall `#1A1A19`
  - bone concrete `#D9D8D3`
  - concrete `#95938D`
- **Typeface:** Host Grotesk, licensed under the SIL OFL.
- **Files.** The working files stay private. The repository gets only exports:
  - SVG for the marks and lockups: paths only, with no embedded fonts, metadata or layer names;
  - PNG for the covers and the small marks.

Acceptance:
- the owner approves the finished set;
- every exported SVG contains only the drawing, as a script check confirms, and every file passes the hygiene test;
- the small marks are crisp at 16, 32 and 64 px, checked by eye at 100%;
- text contrast is at least 4.5:1 on both covers;
- the files land in `docs/assets/brand/` with a short README that says what each file is for.

### G3 Animated explanations of how it works

Goal: the README's "how it works" sections as short motion graphics, in the style of modern product sites: work flowing along the lanes, a commit refused at the gate, a stamp landing on the code it verified.

Design:
- three loops of 6–12 seconds, one per promise: can't skip, can't fake, can't collide;
- animated SVG with CSS keyframes and no scripts. GitHub shows it inline in a README, it stays sharp at any size, and it is small. A GIF would be heavy and blurry, and a video file in the repository does not play inline;
- a dark and a light file per loop, chosen with `<picture>`, and a still frame under `prefers-reduced-motion`;
- made by a dependency-free generator script from the chosen brand direction: its shapes, palette and outlined lettering, with the grain as a still texture so that it never flickers;
- the README keeps the same explanation as text next to each animation, for readers who cannot see it;
- a video cut of the same motion for the launch posts is optional ([L2](L-launch.md#l2-release-notes-and-launch-drafts)).

Acceptance:
- each loop plays in the rendered README on GitHub, checked in Chrome, Firefox and Safari;
- each file is well-formed SVG under 300 KB, with no script;
- with reduced motion, a still frame explains the same thing;
- the hygiene test passes;
- the owner approves the motion.

### G4 More README graphics

Goal: the README shows who ResaLedger is for and why an agent cannot get past it, at a glance, in the same style as the cover and the animation.

Design:
- **Use cases,** as three cards in one image: one person with three agents in worktrees; a team with pull requests and CI as the judge; an operations repository where the work is content and data rather than code. Each card has a small lane drawing and two lines of text.
- **Where a bad commit stops:** the four layers, `AGENTS.md`, the agent hooks, the git hooks and CI, stacked, with what each one stops.
- Static SVG in a dark and a light file, paths only, with the grain as a still texture; the README keeps the same information as text.

Acceptance:
- the owner approves both images;
- each file passes the same checks as the animation, apart from the animation itself.
