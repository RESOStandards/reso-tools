---
name: Precision overlay workflow
description: Multi-pass approach for pixel-precise visual work — backgrounds first, text second, compare to original at every step
scope: local testing (not yet a RESO-wide policy)
related: feedback_yukkuri.md, feedback_no_quick_fixes_cert.md
---

## When to use

Any work where visual precision matters — slide decks, UI screenshots,
PDF generation, image compositing. The key signal is: "the output will
be seen by many people and alignment errors are obvious."

## The three-pass approach

### Pass 1: Background graphics (up to 1 min per unit)

- Create the visual layer with **no text** — just backgrounds, images,
  shapes, fills, gradients
- Measure precisely against the original
- Output: a clean canvas ready for text

### Pass 2: Text layer (up to 1 min per unit)

- Create a separate layer with **all text**, no background
- Measure font sizes, positions, colors against the original
- Output: text positioned correctly in isolation

### Pass 3: Overlay and compare (up to 10 min per unit)

- Combine the two layers
- **Compare to the original at every decision**
- Spin up agents to cross-check alignment if needed
- Never go more than 2 iterations without asking the user
- But do not ask for everything at once — work on independent
  items in parallel, accumulate questions until you have 5+,
  then batch-prompt the user

## Question batching

- When stuck on item A, switch to independent item B
- Get to 2 iterations on B if also stuck
- Continue interleaving until you have ~1 page of questions
- Then prompt the user through all of them at once
- This respects the user's attention — fewer interruptions,
  more context per interruption

## Lessons learned (slide 2 calibration — 2026-04-16)

### Font size conversion: PPTX pt != pixel/DPI math

The naive formula (px * 72 / 300) produces sizes that are too
large in Google Slides. The root cause: PPTX point sizes map
to rendered output at ~96 DPI (screen), but the background image
was created at 300 DPI. The font in the text box needs to
*appear* the same size as the text baked into the 300 DPI image
when both are displayed at the same slide dimensions.

**Calibration rule**: for a 3000px-wide image mapped to 10":
- Measure text height in pixels from the image
- Title was 98px tall on 3000px = 3.27% of slide height
- 3.27% of 5.625" = 0.184" cap height
- Point size ≈ cap_height_inches / 0.70 × 72 ≈ 18.9pt
- But test empirically — render at 17, 18, 19, 20pt and
  compare to the original pixel width ratio

**What went wrong in round 2**: used 33pt (the 300 DPI formula)
which rendered ~75% too large. The title wrapped to 4 lines
instead of 2.

### Container clipping

Text boxes MUST NOT extend beyond their visual container.
For glassmorphic cards, the card boundary is the hard clip
limit. Measure the card container bounds and constrain all
child text boxes to fit within them.

**Card containers on slide 2**: y=1002-1521 (519px tall).
Body text must end above y=1500 to avoid bleeding below
the card edge.

### Logo removal: replace, don't erase

When removing a logo (NotebookLM), don't just paint the
area black. Either:
1. Replace with the appropriate org logo (RESO in this case)
2. Match the exact surrounding background texture/gradient
3. Crop the slide to exclude the area

A visible black rectangle is worse than the original logo.

### Fill color matching

Solid fills on textured/glassmorphic backgrounds are visible
at close range but acceptable at projection distance. Sample
the background color at the CENTER of the text region, not
the edges — the edges are where gradients shift.

### Font size calibration (round 2 → round 3)

The correct PPTX font sizes for a 3000x1688 (300 DPI) background:
- **Title**: 19pt bold — confirmed working
- **Card headings**: 15pt regular (NOT 10pt — that was too small)
- **Card body**: 12.5pt regular (NOT 8.5pt — too small)

The formula that works: measure pixel height, divide by 300 for
inches, divide by 0.72 for cap-height ratio, multiply by 72 for
points, then multiply by 0.75 (empirical correction for PPTX
screen rendering vs. 300 DPI image). Or just use these sizes as
the baseline for this slide template.

### Body box layering technique

Put the body box BEHIND the heading box, starting at or above
the heading's top edge and extending to the card bottom. This
creates a single fill rectangle covering all old text in the
card area. The heading box sits on top with its own fill.

- Body box: starts at ~heading top or slightly above, extends
  to card bottom. Width matches heading width.
- Heading box: floats on top, same width, shorter height.
- Z-order: body first, then heading (add body to slide before
  heading so heading renders on top).

### Body box sizing

- Width must match heading width (1.967" on this template)
- Height must be generous — 1.3"+ to cover old text and provide
  room for word-wrapped replacement text
- Never narrower than the heading — looks misaligned

### Content voice

User feedback: the Switzerland++ text was too abstract/corporate.
The user rewrote card bodies with specific, vivid language:
- Named specific dates (GPT-4, March 2023)
- Named specific capabilities (parse OData, validate payloads)
- Named the audience directly (MLS, vendor)

**Lesson**: Switzerland++ means neutral, not vague. Specific
factual claims are more compelling AND more neutral than
abstract corporate language. "Models can parse OData metadata"
is both specific and neutral. "Studied capabilities across
multiple model generations" is neutral but empty.

### Logo replacement

When replacing a removed logo:
- Use the Cotality logo from the template (larger version)
- Position: ~(8.14", 5.02"), size ~1.77"x0.43"
- Not tiny in the corner — visible but unobtrusive

### Transport deck: what worked first try (zero corrections)

The Transport deck used the RESO template directly (not image
overlays) and got zero corrections. Key factors:
- Template chrome handles layout automatically
- Content was structured with clear patterns (situation/concern/
  question for proposals, orange headings for emphasis)
- Speaker notes were complete and useful
- Switzerland++ applied naturally to workgroup content
- No complex visual reproduction needed

## Interaction with other policies

- **Yukkuri**: this is yukkuri-level work by definition
- **No quick fixes (cert)**: same spirit — never shortcut visual
  precision for speed
- **UI review workflow**: the user may do round-based screenshot
  feedback on the output
- **Chat chunk size**: batch questions to 1-2 pages, not walls
