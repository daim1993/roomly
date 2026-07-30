# Roomly Design System

## Theme

Dark-flat product interface with matte, near-black foundations and restrained neutral surfaces. The visual language is modern, editorial, and technology-forward. Depth comes from tonal separation and thin borders, not blur or heavy shadow.

## Color

- Canvas: `#0B0D0D`
- Navigation: `#101312`
- Surface: `#151918`
- Elevated surface: `#1D2321`
- Border: `#2A302E`
- Primary text: `#F5F5F0`
- Secondary text: `#A7AEAA`
- Muted text: `#707875`
- Coral action and danger: `#FF5A5F`
- Neon green success and presence: `#B7FF4A`
- Soft cyan information and active communication: `#54E5FF`

Accents are semantic and limited. Cyan marks current navigation and communication actions, green marks presence or successful state, and coral marks primary conversion moments plus destructive state where the label or icon makes the meaning explicit.

## Typography

Use Inter with the native system sans stack as fallback. Product labels remain in the same family. Headlines use 700 to 900 weight with tight tracking; body copy uses 400 to 500 weight and comfortable line height. Type scale is fixed and responsive through breakpoints, not fluid viewport interpolation.

## Layout

Desktop uses a stable navigation sidebar, central content pane, and optional member panel. Mobile collapses to a single working pane with a conventional bottom navigation bar. Spacing follows a 4px base rhythm with deliberate 8, 12, 16, 24, and 32px steps.

## Components

- Cards: flat rectangles with 20 to 24px radii, tonal fills, and a one-pixel border.
- Buttons: 12 to 16px soft rectangles or pills where the action is compact.
- Inputs: matte elevated surfaces, clear labels, and a cyan focus ring.
- Lists: mostly borderless rows with tonal hover and selected states.
- Tables: quiet rules, tabular figures, and restrained status chips.
- Icons: existing thin-line SVG system, 18 to 20px in standard controls.
- Scroll areas: contained within their pane; use native scrolling behavior.

## Motion

Use 160 to 240ms transitions with an ease-out-quart curve. Favor opacity, transform, and color changes. Avoid ambient animation, particles, bouncing, layout-property animation, and staggered page-load choreography. Respect `prefers-reduced-motion`.

## Accessibility

Maintain WCAG AA text contrast, visible `:focus-visible` rings, 44px primary touch targets, status labels that pair color with text or iconography, and complete reduced-motion fallbacks.
