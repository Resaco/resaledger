# ResaLedger brand files

The mark is three equal lanes that run parallel through a 45° turn and never cross. The wordmark uses the Resa family lettering, so it is drawn as paths and never set in a font.

| File | Use |
|---|---|
| `mark.svg` | The mark in asphalt, for light backgrounds. 64×64 viewBox with built-in padding. |
| `mark-on-dark.svg` | The mark in bone concrete, for dark backgrounds. |
| `mark-16.png`, `mark-32.png`, `mark-64.png` | The pixel-fitted mark for light backgrounds (favicons, small icons), with a transparent background. Use each at exactly its own size. |
| `mark-16-on-dark.png`, `mark-32-on-dark.png`, `mark-64-on-dark.png` | The same, for dark backgrounds. |
| `lockup.svg` | Mark and wordmark side by side, for light backgrounds. This is the default logo. |
| `lockup-on-dark.svg` | The same, for dark backgrounds. |
| `lockup-by-resaco.svg` | The lockup with the "by Resaco" endorsement, for light backgrounds. Use it where the company context matters, for example in a footer or on an about page. |
| `lockup-by-resaco-on-dark.svg` | The same, for dark backgrounds. |
| `cover-dark.png` | 1280×640 README hero and GitHub social preview. This is the default. |
| `cover-light.png` | The same image on light concrete. |

Palette:

| Name | Hex |
|---|---|
| Asphalt | `#111110` |
| Wall | `#1A1A19` |
| Bone concrete | `#D9D8D3` |
| Concrete | `#95938D` |

Text is set in Host Grotesk, licensed under the SIL Open Font License 1.1. The SVG files contain only paths, with no fonts.

To show the matching lockup in GitHub's light and dark themes, use a `<picture>` element with `prefers-color-scheme`.

Do not recolour, stretch, outline or set the wordmark in a font. Do not add effects. The grain on the covers is part of the image; never add it to the SVG files.
