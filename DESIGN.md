---
name: ClickHouse Dash home page
description: A deep-navy, real-time 3D page for a ClickHouse dashboard built by Circular.fi (docs/index.html, GitHub Pages).
colors:
  ground: "#07111f"
  panel: "#0b182a"
  panel-raised: "#0f1d31"
  line: "#1a3150"
  line-strong: "#2a4468"
  text: "#f4fbff"
  muted: "#9db2c4"
  aqua: "#45e7e1"
  aqua-ink: "#04101c"
  aqua-hover: "#7df0ea"
  track: "rgba(255, 255, 255, 0.12)"
  doc-text: "#d2e3ee"
  doc-code: "#bff6f3"
  code-key: "#93b4ff"
  code-string: "#f2c56b"
  code-url: "#9be3b5"
  code-number: "#c4a8ff"
  code-comment: "#7f97ae"
  code-punct: "#8da4bb"
  code-text: "#d6ecf7"
  fallback-glow: "#0d3358"
  shadow-soft: "rgba(0, 0, 0, 0.6)"
  shadow-mid: "rgba(0, 0, 0, 0.75)"
  shadow-deep: "rgba(0, 0, 0, 0.8)"
  shadow-max: "rgba(0, 0, 0, 0.85)"
typography:
  display:
    fontFamily: "Bricolage Grotesque, Onest, system-ui, sans-serif"
    fontSize: "clamp(1.8rem, 3vw, 2.7rem)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  heading:
    fontFamily: "Bricolage Grotesque, Onest, system-ui, sans-serif"
    fontSize: "clamp(1.9rem, 3.6vw, 3.1rem)"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
  code:
    fontFamily: "ui-monospace, SF Mono, Cascadia Mono, Menlo, Consolas, monospace"
    fontSize: "0.9rem"
    lineHeight: 1.7
  lede:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "clamp(1.1rem, 1.6vw, 1.35rem)"
    lineHeight: 1.55
  footline:
    fontFamily: "Bricolage Grotesque, Onest, system-ui, sans-serif"
    fontSize: "clamp(1.2rem, 2.2vw, 1.7rem)"
    lineHeight: 1.4
  title-lg:
    fontFamily: "Bricolage Grotesque, Onest, system-ui, sans-serif"
    fontSize: "1.5rem"
    lineHeight: 1.3
  title-md:
    fontFamily: "Bricolage Grotesque, Onest, system-ui, sans-serif"
    fontSize: "1.3rem"
    lineHeight: 1.3
  title-sm:
    fontFamily: "Bricolage Grotesque, Onest, system-ui, sans-serif"
    fontSize: "1.15rem"
    lineHeight: 1.4
  doc-title:
    fontFamily: "Bricolage Grotesque, Onest, system-ui, sans-serif"
    fontSize: "clamp(2rem, 3.4vw, 2.9rem)"
    lineHeight: 1.12
  doc-heading:
    fontFamily: "Bricolage Grotesque, Onest, system-ui, sans-serif"
    fontSize: "1.75rem"
    lineHeight: 1.25
  short-screen-title:
    fontFamily: "Bricolage Grotesque, Onest, system-ui, sans-serif"
    fontSize: "1.9rem"
    lineHeight: 1.04
  tiny:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "0.8rem"
    lineHeight: 1.4
  ui:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "0.95rem"
    lineHeight: 1.5
  ui-text:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "0.98rem"
    lineHeight: 1.55
  button:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
  lead-lg:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "1.1rem"
    lineHeight: 1.5
  caption:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "0.85rem"
    lineHeight: 1.5
rounded:
  focus: "8px"
  packet: "2px"
  menu: "10px"
  inline-code: "6px"
  skeleton: "9px"
  frame: "20px"
  code: "14px"
  pill: "999px"
spacing:
  section: "clamp(56px, 10vh, 120px)"
  gutter: "clamp(20px, 5vw, 72px)"
components:
  button-primary:
    backgroundColor: "{colors.aqua}"
    textColor: "{colors.aqua-ink}"
    rounded: "{rounded.pill}"
    height: "52px"
    padding: "0 28px"
  button-ghost:
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    height: "52px"
    padding: "0 28px"
  frame:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.frame}"
---

# Design system: ClickHouse Dash home page

Scope: the public home page in `docs/` only. The application's own interface is a separate system (see `docs/ui-foundations.md`). This page borrows the colour world of Circular.fi's product surfaces (deep navy ground, one aqua accent) because Circular is the publisher; Circular itself is only named, discreetly.

## Overview

One fixed field of 3D columns (WebGL2, no library) sits behind the whole page. ClickHouse is columnar and the Dash mark is four columns, so the page is made of columns, and the columns change shape with the section on screen, each shape being something a ClickHouse server does with big data: a stream of inserts (hero), the sparse primary index with sorted runs merging (features), a latency heatmap that drifts and spikes (OpenTelemetry), a scan sweeping across the table (install). It follows the scroll and the clock, never the pointer. The content is calm: real recordings and screenshots, one diagram, three code blocks. One theme (dark), one accent (aqua), motion only on transform, clip-path and opacity.

## Colors

- **Ground** `#07111f` with panels `#0b182a` and `#0f1d31`; hairlines `#1a3150` (`#2a4468` for controls).
- **Aqua** `#45e7e1` is the only accent: primary button, the word ClickHouse in the headline, active chapter, icons, copy confirmation, data packets. Text on aqua is `#04101c`.
- **Text** `#f4fbff`, secondary `#9db2c4` (at least 7:1 on the ground). 

## Typography

Bricolage Grotesque for display and headings (weight 600, tight tracking), Onest for body, the system monospace for commands, config and table names (no font to download). Bricolage and Onest are self-hosted variable woff2, subset to Latin (SIL OFL, licenses in `docs/assets/fonts`). Display never exceeds 6 rem; body measure stays under 65 characters.

## Layout

Asymmetric and left-weighted: the hero copy sits bottom-left over the dark side of the column field. The tour is a centred 16:9 frame; the story is a sticky text column beside a sticky screenshot stack; the flow and the install panel use unequal grids (the install step with the download spans the full width, the config and run steps split 7 and 5). One 64 px navigation line. Below 960 px everything collapses to one column and the screenshot stays pinned under the navigation.

## Elevation & Depth

Neutral black shadows with an offset and a short blur (about 24 px); frames are outlined with a 1 px ring shadow. The only coloured light on the page is the column field itself. No glow shadows, no gradient text.

## Shapes

One scale: 20 px frames and cards, 14 px code blocks, full pills for every button, chip and tab.

## Components

- **Hero and player:** the video is the first thing on the page: one compact row (a one-line headline with the sentence under it on the left, the Download and Run buttons with a line of facts on the right), then the 16:9 player sized to the rest of the viewport height, with the column field around it and the video credit under it. The video autoplays muted and loops while on screen, and enters with a short 3D lift. Sound, Pause and Full screen are buttons inside the player, in a bar that shows on hover, on focus, when paused and for a few seconds after a tap; clicking the video pauses it. There are no chapter buttons. Below 780 px of height the sentence and the facts line are dropped and the headline and buttons shrink, so the video stays in the first screen.
- **Column field:** instanced cubes, the heights of four shapes (inserts stream, sparse primary index with merging runs, latency heatmap, scan sweep) computed in the vertex shader and mixed by a stage taken from the scroll. The camera, the brightness and a navy veil change with the stage so text stays readable. Pauses in hidden tabs; draws still frames on scroll under `prefers-reduced-motion`; hidden (with a gradient fallback) without WebGL2. It never follows the pointer.
- **Features:** a bento of the six pages, each card a link to its documentation page (hover lifts it and moves the arrow), with a real screenshot.
- **Flow:** three rows, collector to table to page, with packets running along the pipes while the section is visible.
- **Install:** the platform tab rewrites the archive name in the commands; Copy buttons confirm for 1.6 s. Code is coloured by a 3 kB highlighter (shell, HCL, SQL, JSON, HTTP, YAML): commands in the page accent, keys and flags in the accent text blue of ClickHouse Dash (#93b4ff), strings amber, URLs green, numbers and keywords violet, comments grey.
- **Documentation (`documentation.html`):** the Markdown files of `docs/` fetched and rendered in the browser with marked; a filterable menu, an on-this-page list, previous and next cards, copy buttons on code, wide tables that scroll inside their box. Links between files, anchors, images and links to repository files are rewritten. The list of pages lives in `docs/assets/docs.js` and a repository check keeps it equal to `docs/*.md`.
- **Circular:** a discreet reference, never a logo: "by circular.fi" in small muted type right after the name in the navigation, and one quiet footer line. Every mention is a link to https://circular.fi; GitHub always carries its mark.
- **Hover:** only what can be clicked reacts to the pointer.

## Performance

The page is built to cost little, and `tests/harness/test_docs_site.py` guards the numbers: the video is a full HD, 24 fps, 6.7 MB copy (a 2.5 MB 720p copy for Save-Data and phones) that starts when the page is idle and plays once; images are AVIF with WebP fallback at two widths (under 70 kB each); two subset fonts (63 kB); a 3 kB icon sprite; no web font for code; no blur behind the navigation (it would repaint over the animated canvas); sections below the fold use `content-visibility: auto`. The column field computes its heights on the CPU for the two shapes in use, draws one instanced call at 24 frames per second (10 when left alone), at most 1.25 device pixels per pixel, without multisampling, on the low-power GPU, measures its own frame time and lowers its resolution or stops animating when the machine cannot keep up, and stops in hidden tabs. Reduced motion and Save-Data get still frames and no autoplay.

## Do's and Don'ts

- Do keep one accent and one corner scale; do show the real product (video, screenshots), never a drawn mock-up.
- Do keep every string plain and factual; the only numbers are real (6.6 MB archive, 4 platforms, 74 seconds).
- Don't add eyebrows, section numbers, em-dashes, glow shadows, gradient text or a second marquee.
- Don't animate layout properties; don't leave an infinite animation running off screen.
