# DESIGN.md

The design system and the design decisions behind Atlas. Code is the source of
truth for values (`apps/web/src/index.css`, the components); this file explains
them and the choices that must survive future changes.

## Concept: a survey chart

Atlas is an atlas for ideas, so the visual language is a **surveyor's chart**:
paper (or night-sea) ground, ink text, thin chart lines, small round survey nodes,
and one metal accent, **meridian brass**, for what matters now (the selected
topic, the route, citations, the primary action). Decoration is limited to the
chart itself: a faint network of real topics behind the opening screen.

Everything else is reading: serif body text at a comfortable measure, generous
whitespace, no card grids, no gradients.

## Principles

1. **Reading first.** The main canvas is Wikipedia text in a centered column. The
   AI talks in the chat; web context and history live in side panels. Nothing on
   the page waits for the AI.
2. **Provenance is visible.** Every AI-written block says so ("Written by AI from
   the sources on this page. Check the citations.") and cites numbered sources;
   Wikipedia text carries CC BY-SA attribution; web passages are labelled with
   their site.
3. **One accent.** Brass marks the current focus. Don't introduce a second accent
   color; use ink, muted ink and chart tones for everything else.
4. **Quiet motion.** Motion only explains a change (a page arriving, a brief
   revealing beat by beat, a line drawing in). All of it switches off under
   `prefers-reduced-motion`.
5. **Calm interaction.** Free scrolling (no snapping), no jitter (layouts are
   computed to rest), nothing jumps while you read.
6. **Readable at any zoom.** Charts keep dots and labels at a constant screen
   size, and labels that would collide are left out rather than overlapped.

## Color

Tokens are CSS custom properties defined for light and dark in
`apps/web/src/index.css`. They override HeroUI's theme variables (HeroUI declares
them in `@layer base`; ours are unlayered, so they win). Always use tokens, never
raw hex in components.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `#edf1f4` survey sheet | `#0f1b2a` abyss | page ground |
| `--foreground` | `#132235` ink | `#e4ebf2` ink | text |
| `--surface` | `#ffffff` | `#16263a` plate | panels, cards, chat |
| `--surface-secondary` / `-tertiary` | `#e3e9ee` / `#d8e0e7` | `#1c2f46` / `#223852` | skeletons, placeholders |
| `--overlay` | `#ffffff` | `#1a2c42` | tooltips, popovers |
| `--muted` | `#536477` | `#8c9db2` | secondary text, meta |
| `--default` | `#dfe6ec` | `#1f3249` | segmented-control track, neutral buttons |
| `--border` | `#c6d1db` | `#2b3f58` | card and panel borders |
| `--separator` | `#d3dce4` | `#22354c` | rules between sections |
| `--field-line` | `#6f8396` (3.4:1) | `#6a7f99` (4.2:1) | input underline, graph dot stroke (non-text contrast ≥ 3:1) |
| `--field-placeholder` | `#5f6f81` (4.5:1) | `#7d8fa5` (5.3:1) | placeholder text |
| `--accent` | `#8a5a00` brass (darkened for paper) | `#e3b04b` brass | focus, selection, route, citations, primary button |
| `--accent-foreground` | `#ffffff` | `#1b1404` | text on brass |
| `--focus` | = accent | = accent | focus rings |
| `--chart-line` / `--chart-node` / `--chart-label` | `#9fb0c1` / `#6f8396` / `#6a7b8d` | `#2f4561` / `#4d6583` / `#5f7590` | backdrop and map lines, nodes, labels |
| `--added` / `--added-bg` / `--added-fg` | `#2f7d4f` / `#e1f1e6` / `#1c4f31` | `#5cc489` / `#183a2a` / `#b5ecc8` | text added (history) |
| `--removed` / `--removed-bg` / `--removed-fg` | `#b4473f` / `#f8e1df` / `#7a2620` | `#ef8a80` / `#47212a` / `#f6c1bb` | text removed (history) |

Rules:
- **Contrast**: text meets WCAG AA; non-text UI (field lines, dots) meets 3:1.
  The light accent is deliberately darker than the dark one.
- **Added/removed are never color-only**: diffs use `<ins>`/`<del>` with
  strikethrough on removals and screen-reader "[added: …]" text; chart marks use
  shape (filled = more added, hollow ring = more removed).
- **Status dots** on tabs use the accent (pulsing while loading, steady when ready).

## Themes

- **Dark is the default.** `index.html` applies the saved theme before first
  paint (`localStorage.theme`), setting both `class` and `data-theme` on `<html>`.
- Tailwind's `dark:` variant follows the theme class, not the OS
  (`@custom-variant dark`).
- The toggle is in the sidebar (desktop) and the compact header (phones).
- Every new color needs a light and a dark value; check both in screenshots.

## Typography

| Family | Token | Use |
|---|---|---|
| **Newsreader** (variable, `@fontsource-variable/newsreader`) | `font-serif` | reading text, page and question headings, AI answers, briefs, overview text, diffs, the brand |
| **Public Sans** (variable, `@fontsource-variable/public-sans`) | `font-sans` (body default) | interface: labels, buttons, meta, chart labels, tabs |

Fonts are bundled (no external font requests). Scale in use:

| Role | Style |
|---|---|
| Opening question | serif, `clamp(2.25rem, 5.5vw, 4.25rem)`, leading 1.05, tracking −0.015em, `text-balance` |
| Page heading (sticky) | serif, `text-2xl` → `sm:text-3xl`, `text-balance` |
| Lead article title | serif `text-2xl` |
| Article lead text | serif `1.125rem`, leading 1.7 |
| AI answer in chat | serif `1.02rem`, leading 1.65 |
| Compact brief headline | serif `1.6rem` → `1.85rem` |
| Chat question / history change titles | serif `text-lg` / sans medium |
| Section headings in panels | sans `text-sm font-semibold` |
| Meta, captions, disclosures | sans `text-xs`/`text-sm`, `--muted` |

Conventions: sentence case everywhere; no all-caps labels; numbers in charts and
counts use `tabular-nums`; serif italics only for the decorative backdrop labels
and quoted edit summaries.

## Layout

```
┌────────┬──────────────────────────────────────┬───────────────────┐
│Sidebar │ Header: question · Detailed|Compact  │ Side panel        │
│ w-64   │ · Save                               │ 28rem / 32rem (xl)│
│ brand  ├──────────────────────────────────────┤ Chat|Map|Context| │
│ saved  │ Sticky page header (centered column) │ History tabs      │
│ theme  │                                      │                   │
│        │   Reading column, centered           │  (collapses to a  │
│        │   max-w-3xl, px-12 / sm:px-16    ●   │   w-14 rail with  │
│        │                                  ○   │   one button per  │
│        │                       page dots →    │   tab)            │
│        │   ┌ floating chat, max-w-2xl ┐       │                   │
│        │   └ (or docked in side panel)┘       │                   │
└────────┴──────────────────────────────────────┴───────────────────┘
```

- **Reading column**: `PAGE_COLUMN` (`mx-auto w-full max-w-3xl px-12 sm:px-16`)
  in `ResearchPageView.tsx`, shared by page headers, detailed and compact pages
  and the loading placeholder, so headings align with text and nothing shifts
  when a page finishes loading. Padding is symmetric (it also clears the dots), so
  the column is truly centered.
- **Page header** is sticky at the top of each page: "Page N of M", the step kind,
  and the question.
- **Pages** are at least the canvas height and stacked vertically; scrolling is
  free (no snapping). **Page dots** on the right show the page in view and jump
  to a page; hovering shows the page's question.
- **Chat**: floating at the bottom center (`max-w-2xl`, `rounded-2xl`, soft
  shadow) or docked into the side panel as the **Chat** tab with the input pinned
  under every tab ("Move to side panel" / "Move to the middle"). Docking needs a
  wide screen and an open panel; otherwise the chat floats.
- **Side panel**: tabs Chat (when docked) | Map | Context | History. Collapses to
  a rail with one icon + vertical label per tab and status dots; Alt+1… open tabs.
- **Phones** (`< lg`): no side panel beside the canvas; a header switch toggles
  Research | Map | Context | History; header controls wrap; no horizontal scroll
  at 390 px.

## Components and patterns

- **HeroUI v3** provides buttons, fields, forms, links, skeletons, spinners and
  alerts, themed by our tokens. Primary actions use the default (brass) button;
  secondary use `variant="secondary"`; icon-only controls use `variant="ghost"`
  and always have an `aria-label`.
- **Segmented controls** (Detailed|Compact, panel tabs, Auto|Articles|Context): a
  `rounded-full bg-default p-0.5` track with the active option as a raised
  `bg-background` pill. Use `aria-pressed` (toggles) or `role="radio"` (choices).
- **Question input** on the opening screen is a chart line, not a box: a 1px
  underline that becomes a 2px brass line on focus (`.question-input`). Chat
  inputs are plain fields.
- **Cartouche**: the opening content sits on a cleared patch of the chart (solid
  background with a feathered edge) so backdrop lines never cross text.
- **Citations** are small brass superscripts linking to numbered sources;
  numbers outside the source list are dropped rather than shown as dead links.
- **Cards** are used sparingly: `rounded-lg border bg-surface` for list items
  that expand (history changes); the selected one gets a brass border.
- **Radius scale**: `rounded-full` for pills, badges and dots; `rounded-lg` for
  cards, inputs and small surfaces; `rounded-xl` for images; `rounded-2xl` only
  for the floating chat.
- **Tooltips** use `Floating` (portal into `body`, fixed positioning, stays in
  the viewport); they repeat information available elsewhere, so they're hidden
  from assistive tech.
- **Loading** uses skeletons shaped like the content plus a one-line spinner
  status in plain words ("Reading the edit history. The first time takes a few
  seconds."). Errors say what happened and offer "Try again".
- **Empty states** explain what will appear and how to get it.

## Data visualization

All charts follow: thin marks, recessive lines, one accent for focus, constant
on-screen dot and label sizes under zoom, no dual axes, legend or direct labels
so meaning is never color-only, and keyboard and screen-reader access.

- **Topic map** (`TopicGraph.tsx`): a **force-directed network**, not a tree or
  rings. The center is fixed and largest; other dots grow with their number of
  connections (hubs stand out). Every relation is a straight line ("also related"
  links slightly fainter). Layout is computed to rest once (no jiggle). Hover,
  focus or selection highlights the topic, its neighbours and its route to the
  center in brass and dims the rest. Labels sit under dots on a background halo
  (`paint-order: stroke`) and are placed by priority (center, topic in hand,
  neighbours, first ring, hubs), skipping any that would overlap another label,
  another dot, or the panel edge. Pan, zoom (wheel, buttons), drag topics, "Fit map".
- **History timeline** (`HistoryPanel.tsx`): time left to right, **one row per
  article section**, marks sized by words changed (filled `--added` = more
  added, hollow `--removed` ring = more removed), a hairline and numbered button
  per change (spread apart when close in time), the article's size as a step line
  on top, year ticks below, legend underneath. Selecting a change highlights its
  column and opens its diff.
- **Diffs**: serif text, unchanged context in muted ink, `<ins>` on
  `--added-bg`, `<del>` with strikethrough on `--removed-bg`, grouped by section,
  plus a link to the diff on Wikipedia.
- **Article size chart** (history page, `HistoryChart.tsx`): step line with brass
  markers for the important edits.
- **Compact brief**: a vertical timeline or key points revealed beat by beat
  (with optional read-aloud), each with source chips.
- **Backdrop** (`AtlasBackdrop.tsx`): a fixed-seed network of real topics in chart
  tones, faded under the opening content and dimmed during exploration.

## Motion

Defined in `index.css`, all inside `@media (prefers-reduced-motion: no-preference)`:

| Effect | Where | Timing |
|---|---|---|
| Lines draw in (`.draw-in`) | backdrop | 1100ms, staggered 28ms |
| Markers fade/scale in (`.marker-in`) | timelines | 420ms, staggered 45ms |
| Beat rises in, rail draws down (`.beat`, `.rail`) | compact briefs | 650ms / 900ms |
| Node fades in (`.node-in`) | topic map | 500ms |
| View transition, question morphs into the page heading | opening → exploration | 260ms / 420ms |
| Smooth scroll to a page or a change | canvas, panels | browser smooth (auto when reduced) |

Easing for entrances: `cubic-bezier(0.3, 0.7, 0.2, 1)`. JS checks
`prefersReducedMotion()` (`lib/motion.ts`) before animating views or scrolling.

## Accessibility

- Visible focus everywhere (`focus-visible:ring-2 ring-focus`, brass).
- Landmarks and labels: research canvas, side panel, page navigation (`nav`
  "Pages"), every icon button labelled, map nodes are focusable buttons with
  descriptive labels.
- Live regions announce finished answers, not streaming text word by word.
- Keyboard: Enter/Space select map topics; Alt+1… open side-panel tabs
  (`aria-keyshortcuts`); chat and voice controls are reachable by Tab.
- Voice: push-to-talk and hands-free with a visible level and threshold control.

## Writing

- Plain, specific, sentence case; name things by what people understand
  ("Context", "History", "See how this article changed"), not by implementation.
- Buttons say what happens ("Find context", "Open this diff on Wikipedia",
  "Move to side panel").
- Label AI output honestly and briefly; never present it as Wikipedia's text.
- Errors explain and offer a next step; no apologies, no vagueness.

## Decisions log (keep unless the user changes them)

| Decision | Why |
|---|---|
| Wikipedia only on the page; AI answers in the chat | the AI is slower; the page shouldn't wait, and sources stay distinct from generated text |
| Web context only in its own panel | keep Wikipedia and the web apart |
| One input with Auto / Articles / Context; nothing on the canvas while Auto decides | one place to ask; no flicker |
| Chat can dock into the side panel | leaves the canvas for reading |
| Free scrolling with page dots (no snap) | snapping felt sluggish |
| Centered reading column | balanced reading area when panels collapse |
| Force-directed network map | earlier ring and left-to-right tree layouts read as "flow"; a network shows real relations |
| Collision-free label placement | readable at any zoom |
| Collapsed side panel shows one button per tab + Alt shortcuts | direct access to each panel |
| History lists only substantial changes, with diffs | trust: people can verify each claim quickly |
| Dark theme by default, brass accent, serif reading type | the chart identity |

## Housekeeping

- `.graph-ring` in `index.css` is left over from the ring and column map layouts
  and is no longer used by the network map; remove it when touching that CSS.
- When adding UI: use tokens, check light and dark, phone width (390 px), reduced
  motion, keyboard focus, and take a screenshot before calling it done.
