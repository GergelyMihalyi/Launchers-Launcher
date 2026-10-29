# Themes

Code: `themes/themes.json` (the manifest), `themes/<id>.css`, `styles/*.css` (the base = the `neon` theme),
`renderer/settings/settings-theme.js`, `renderer/boot/boot-theme.js`.

## How a theme works

`themes/themes.json` is the **single source of themes**: `[{ id, label, swatch: [--bg, --surface, --accent], motion?:
"off" }]`. It is a versioned data file required by `main.js` (not by `lib/config.js`), and it stays in `themes/`
because that folder is a self-contained unit (manifest + every `<id>.css`). Everything derives from it: main's `THEMES`
whitelist (`themeManifest.map(t => t.id)`, an unknown stored id → `neon`), the renderer's `THEMES` (`list-themes`), the
`<link>` injection of the non-`neon` themes, the `t`-key cycling and the Look → Theme sub-view's swatch strip (three
colours rendered from inline style — the hex format is guaranteed by `test/contracts/themes.test.js`).

**A new theme = two places:** one manifest row + one `themes/<id>.css` (usually one block
`:root[data-theme="<id>"] { …tokens… }`). The test checks manifest ↔ `<id>.css` pairing, the
`:root[data-theme="<id>"]` scope and `{}` balance — it does not look at other files in `themes/`.
A theme id may contain a hyphen (`pixel-rpg`); `data-theme`, the CSS selector, the file name and the `<link>`
injection all handle it. The `neon` base theme has no attribute (`styles/*.css` itself).

Themes are **not** loaded by `index.html`: `renderer/main.js` injects a `<link rel="stylesheet" href="themes/<id>.css">`
per non-`neon` manifest entry (the CSP `style-src 'self' file:` allows it); the boot script injects the active one
before first paint (no flash of the default theme, see [renderer/overview.md](renderer/overview.md#boot-scripts-and-first-paint)).
Rules use native CSS nesting (`:root[data-theme="<id>"] { & … }`, Chromium 112+). A Google Fonts `@import` at the top of a
theme CSS is allowed (the CSP admits `fonts.googleapis.com`): so far Fredoka (nintendo, famicom, gamecube), Silkscreen
(win31), Inter (deck), VT323 (c64), Pixelify Sans (pixel-rpg). `win31` and `xp` import nothing: they build on system fonts
(`Tahoma`/`Trebuchet MS`/`Silkscreen`) with a `DejaVu Sans` fallback.

## Tokens (set a token, not a selector)

Most themes set tokens: `--font-body` / `--font-display` (`.btn-icon` **deliberately** hard-codes `Orbitron` for flex-centred
glyph alignment), `--focus-shadow` / `--focus-shadow-danger` (the full `box-shadow` value; the old `--glow` hack that
fell back to "transparent but valid" is gone — a flat theme sets `--focus-shadow: 0 0 0 2px var(--accent)`; glowing ones use
`color-mix(... var(--focus-glow-color) N%, transparent)` so the per-launcher `--card-accent` shines through),
`--scanline-opacity` (`0` = none), `--ambient` (the `.bg-glow` background — even a compound gradient fits a token),
`--card-radius`, `--card-border`, `--corner-decor` (`none` = no corner decoration), `--card-bg-opacity` (the blurred background
icon; `0` = off — `win31`/`oled`/`amber`; `deck` 0.22, `neon` 0.16). What does not fit a token (the `.header h1` gradient
text, `win31` bevels, button colours) remains a selector override.

**Gotcha — the old `--glow`:** a multi-layer `box-shadow: var(--glow), inset …` breaks when `--glow` is `none`; that is why
the whole value became the `--focus-shadow` token.

## The themes (15)

`neon` (base), `nintendo`, `win31` (`motion: off`), `deck`, `oled`, `nord` (`motion: off`), `amber`, `vapor`, `ps2`,
`famicom`, `gamecube`, `dreamcast`, `c64`, `xp`, `pixel-rpg`.

- **`xp`** (Windows XP "Luna" blue): a Luna-blue desktop (`--ambient` vertical blue gradient), beige-silver panel
  (`--surface: #ece9d8`), blue title strips, blue selection (`--accent: #2f6fd6`), a green Start-button feel (`--running`,
  `.btn-ps/.btn-square`, progress bars), orange (`--accent2: #e07b18`) for warnings, `Tahoma`/`Trebuchet MS`, **no
  `motion` flag** (XP had soft fades, the carousel slide stays), `--card-bg-opacity: 0`, `--card-radius: 8px`. It replaces
  `.bg-glow` with the iconic "Bliss" desktop: `themes/xp-bliss.jpg` (a freely licensed look-alike photo, Unsplash /
  Shibin Joseph, 2880×1800; in `themes/` because the theme is self-contained), a relative `url()` from `xp.css`
  (`img-src 'self' file:` allows it), a light bluish scrim for hint legibility, `var(--ambient)` as the last fallback layer.
- **`pixel-rpg`** (16-bit JRPG — a gold ▶ cursor, navy message windows) also **pixelates the card icons (`.app-icon`)**, not
  with pure CSS (two attempts failed) but by JS pre-processing: `carousel.js` `pixelateIconUrl(src, cb)` draws the icon on a
  `12×12` `<canvas>` and makes a real small bitmap via `toDataURL()` (cached by path); `pixelateCardIcon(img)` sets it (or the
  original on other themes) as the `<img data-icon-src>` `src`; `refreshIconPixelation()` re-runs it for all cards (also called
  by `applyTheme()` so live switching in the Theme sub-view updates at once). The theme CSS then only sets
  `image-rendering: pixelated` (nearest-neighbour up-scaling — the bitmap is genuinely 12×12). **Why pure CSS did not work:**
  the icon sources are mixed (`steam`/`retroarch` **SVG**, the rest PNG); Chromium can re-render vector sources at the *final*
  (enlarged) resolution, even with `will-change: transform`, skipping the small raster step, so no blockiness appeared.
- **`win31`** and **`nord`** switch animations off (`motion: "off"`); the loader bar then becomes static too.

## Backgrounds

`background` config = a **per-theme** map; built-in images are `assets/backgrounds/<id>.svg` (hand-written dark abstract SVGs,
1920×1080 viewBox, `cover`-scaled) whitelisted by `data/backgrounds.json` (`[{ id, label, swatch }]`; `test/contracts/data.test.js`
guards the SVG ↔ row pairing; a new background = one SVG + one manifest row). Custom images come from
`~/Pictures/launchers-launcher/`. The renderer's `#bgCustom` layer (above `.bg-glow`, same `z-index: 0`) carries `url("assets/
backgrounds/<id>.svg")` (a relative path, like the icons) plus a mandatory fixed scrim
(`#bgCustom.active::after`, a dark gradient ~0.45 → 0.62). It is additive — the theme system is not touched — but it hides the
`xp` Bliss image and every theme's `--ambient`. See [config-keys.md](config-keys.md#look-and-language) for the limits.

## Motion and contrast

See [renderer/overview.md](renderer/overview.md#accessibility): `data-motion="off"` (a theme flag **or** the user's switch) and
`data-contrast="high"` (user switch, theme-independent).
