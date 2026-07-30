# Fonts

Both families are self-hosted rather than loaded from a CDN. That is a
deliberate choice: this app is meant to run on a laptop that may be offline,
and a webfont request to a third party would leak every page view.

The files are the `latin` subsets produced by Google Fonts, ~67 KB in total.

| File | Family | Licence |
|---|---|---|
| `archivo-var-latin.woff2` | [Archivo](https://github.com/Omnibus-Type/Archivo) (variable, 400–800) | SIL Open Font License 1.1 |
| `spacemono-400-latin.woff2` | [Space Mono](https://github.com/googlefonts/spacemono) 400 | SIL Open Font License 1.1 |
| `spacemono-700-latin.woff2` | Space Mono 700 | SIL Open Font License 1.1 |

The OFL permits redistribution of the font files, including bundled with an
application, provided they are not sold on their own and the licence travels
with them. Full licence text:
<https://openfontlicense.org/open-font-license-official-text/>

Upstream licence files: [Archivo](https://github.com/Omnibus-Type/Archivo/blob/master/OFL.txt) ·
[Space Mono](https://github.com/googlefonts/spacemono/blob/main/OFL.txt)

## Why these two

The split is a rule in `style.css`, not a preference: Archivo speaks, Space
Mono is allowed only for data — counts, positions, catalogue numbers,
durations, times, config keys. If it is a sentence, it is not mono.
