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

Scope: the public home page in `docs/` only. The application's own interface is a separate system (see `docs/ui-foundations.md`). This page uses the colour world of the Circular.fi product surfaces: a deep navy ground and one aqua accent. Circular is the publisher, so Circular is named only in a discreet way.

## Overview

One fixed field of 3D columns sits behind the whole page. The field uses WebGL2 and no library. ClickHouse is columnar, and the Dash mark is four columns. So the page is made of columns. The columns change shape with the section on screen.

Each shape shows one task of a ClickHouse server with big data. The hero shows a stream of inserts. The features section shows the sparse primary index, with sorted runs that merge. The OpenTelemetry section shows a latency heatmap that drifts and spikes. The install section shows a scan that sweeps across the table.

The field follows the scroll and the clock, never the pointer. The content is calm. It has real recordings and screenshots, one diagram and three code blocks. The theme is dark. The only accent is aqua. Motion uses only transform, clip-path and opacity.

## Colors

- **Ground** `#07111f` with panels `#0b182a` and `#0f1d31`; hairlines `#1a3150` (`#2a4468` for controls).
- **Aqua** `#45e7e1` is the only accent: primary button, the word ClickHouse in the headline, active chapter, icons, copy confirmation, data packets. Text on aqua is `#04101c`.
- **Text** `#f4fbff`, secondary `#9db2c4` (at least 7:1 on the ground). 

## Typography

The display and heading font is Bricolage Grotesque (weight 600, tight tracking). The body font is Onest. The page uses the system monospace font for commands, config and table names. The monospace font needs no download.

Bricolage and Onest are self-hosted variable woff2 files, subset to Latin. Their licenses are SIL OFL, and the license texts are in `docs/assets/fonts`. Display never exceeds 6 rem. The body measure stays under 65 characters.

## Layout

The layout is asymmetric and left-weighted. The hero copy sits bottom-left, over the dark side of the column field. The tour is a centred 16:9 frame, and the story is a sticky text column beside a sticky screenshot stack. The flow and the install panel use unequal grids. In the install panel, the download step spans the full width. The config and run steps split 7 and 5.

The navigation is one line, 64 px high. Below 960 px, all content collapses to one column. The screenshot stays pinned under the navigation.

## Elevation & Depth

Shadows are neutral black. Each shadow has an offset and a short blur of about 24 px. Frames have a 1 px outline. A ring shadow draws it. The only coloured light on the page is the column field itself. The page uses no glow shadows and no gradient text.

## Shapes

One scale: 20 px frames and cards, 14 px code blocks, full pills for every button, chip and tab.

## Components

- **Hero and player:** the video is the first thing on the page, in a compact top row. The row has a one-line headline, with the sentence under it, on the left. On the right, it has the Download and Run buttons and a line of facts. Below the row, the 16:9 player fills the rest of the viewport height. The column field surrounds the player, and the video credit is under it. The video autoplays muted, loops while on screen, and enters with a short 3D lift.

  Sound, Pause and Full screen are buttons inside the player. The bar appears on hover, on focus, when paused, and for a few seconds after a tap. A click on the video pauses it. There are no chapter buttons. Below 780 px of height, the sentence and the facts line are removed. The headline and the buttons shrink, so the video stays in the first screen.
- **Column field:** instanced cubes. The vertex shader computes the heights of four shapes: inserts stream, sparse primary index with sorted runs that merge, latency heatmap and scan sweep.

  A stage taken from the scroll mixes the shapes. The camera, the brightness and a navy veil change with the stage, so text stays readable. The field pauses in hidden tabs. Under `prefers-reduced-motion`, it draws still frames on scroll. Without WebGL2, the page hides the field and shows a gradient fallback. It never follows the pointer.
- **Features:** a bento of the six pages. Each card is a link to its documentation page. Hover lifts the card and moves the arrow. Each card has a real screenshot.
- **Flow:** three rows: collector to table to page. Packets run along the pipes while the section is visible.
- **Install:** the platform tab changes the archive name in the commands. Copy buttons confirm for 1.6 s. A 3 kB highlighter colours the code. It supports shell, HCL, SQL, JSON, HTTP and YAML.

  Commands use the page accent. Keys and flags use the ClickHouse Dash blue (#93b4ff). Strings are amber. URLs are green. Numbers and keywords are violet. Comments are grey.
- **Documentation (`documentation.html`):** the page fetches the Markdown files of `docs/`. It renders them in the browser with marked. The page has these parts: a filterable menu, an on-this-page list, previous and next cards, copy buttons on code, and wide tables. Wide tables scroll inside their box.

  The page rewrites links between files, anchors, images and links to repository files. The list of pages lives in `docs/assets/docs.js`. A repository check keeps that list equal to `docs/*.md`.
- **Circular:** a discreet reference, never a logo. The text "by circular.fi" is small and muted. It appears right after the name in the navigation, and in one quiet footer line. Every mention is a link to https://circular.fi. GitHub always carries its mark.
- **Hover:** only what can be clicked reacts to the pointer.

## Performance

The page is built to cost little. `tests/harness/test_docs_site.py` guards the numbers. The video is a full HD copy of 6.7 MB at 24 fps. A 2.5 MB 720p copy serves Save-Data and phones. The video starts when the page is idle, and it plays once.

Images are AVIF with a WebP fallback, at two widths, and each image is under 70 kB. There are two subset fonts (63 kB). The icon sprite is 3 kB, and no web font is used for code. The page uses no blur behind the navigation. A blur repaints the animated canvas under it. Sections below the fold use `content-visibility: auto`.

The column field computes its heights on the CPU for the two shapes in use. It draws one instanced call at 24 frames per second (10 when left alone) on the low-power GPU. Its resolution is at most 1.25 device pixels per pixel, without multisampling. It measures its own frame time. When the machine cannot keep up, it lowers its resolution or stops the animation. It also stops in hidden tabs.

Reduced motion and Save-Data get still frames and no autoplay.

## Do's and Don'ts

- Keep one accent and one corner scale. Show the real product (video, screenshots), never a drawn mock-up.
- Keep every string plain and factual. The only numbers are real (6.6 MB archive, 4 platforms, 74 seconds).
- Do not add eyebrows, section numbers, em-dashes, glow shadows, gradient text or a second marquee.
- Do not animate layout properties. Do not keep an infinite animation active when it is off screen.
