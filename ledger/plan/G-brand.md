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

Goal: the chosen direction, finished and exported into the repository: the logo files, the README cover and the social preview, in light and dark variants where the README needs them.

Acceptance: to be written when G1 is decided.

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
