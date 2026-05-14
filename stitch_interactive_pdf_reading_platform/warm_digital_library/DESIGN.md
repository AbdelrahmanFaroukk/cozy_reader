---
name: Warm Digital Library
colors:
  surface: '#fbf9f4'
  surface-dim: '#dbdad5'
  surface-bright: '#fbf9f4'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f5f3ee'
  surface-container: '#f0eee9'
  surface-container-high: '#eae8e3'
  surface-container-highest: '#e4e2dd'
  on-surface: '#1b1c19'
  on-surface-variant: '#554336'
  inverse-surface: '#30312e'
  inverse-on-surface: '#f2f1ec'
  outline: '#887364'
  outline-variant: '#dbc2b0'
  surface-tint: '#904d00'
  primary: '#8d4b00'
  on-primary: '#ffffff'
  primary-container: '#b15f00'
  on-primary-container: '#fffbff'
  inverse-primary: '#ffb77d'
  secondary: '#695c51'
  on-secondary: '#ffffff'
  secondary-container: '#efdcce'
  on-secondary-container: '#6e6055'
  tertiary: '#605b58'
  on-tertiary: '#ffffff'
  tertiary-container: '#797470'
  on-tertiary-container: '#fffbff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdcc3'
  primary-fixed-dim: '#ffb77d'
  on-primary-fixed: '#2f1500'
  on-primary-fixed-variant: '#6e3900'
  secondary-fixed: '#f2dfd1'
  secondary-fixed-dim: '#d5c3b6'
  on-secondary-fixed: '#231a11'
  on-secondary-fixed-variant: '#51443a'
  tertiary-fixed: '#e8e1dd'
  tertiary-fixed-dim: '#ccc5c1'
  on-tertiary-fixed: '#1e1b19'
  on-tertiary-fixed-variant: '#4a4643'
  background: '#fbf9f4'
  on-background: '#1b1c19'
  surface-variant: '#e4e2dd'
typography:
  display-lg:
    fontFamily: Literata
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Literata
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
  headline-lg-mobile:
    fontFamily: Literata
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
  body-lg:
    fontFamily: Literata
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 32px
  body-md:
    fontFamily: Literata
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 28px
  label-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 8px
  container-max: 1120px
  gutter: 24px
  margin-mobile: 20px
  margin-desktop: 64px
---

## Brand & Style
The design system is anchored in the "Cozy & Tactile" aesthetic, seeking to replicate the sensory calm of a physical reading nook. It targets casual readers who view reading as a ritualistic escape rather than a chore. 

The style is **Tactile Minimalism**. It avoids the sterile coldness of typical SaaS platforms in favor of high-quality typography and subtle physical metaphors. We use parchment-inspired surfaces, organic layering, and generous whitespace to create a "breathable" interface that reduces cognitive load and eye strain. The goal is to evoke the feeling of a heavy, well-made book held in the hands—grounded, intentional, and timeless.

## Colors
The palette is centered on high-legibility and warmth. 
- **Primary (Amber):** Used sparingly for interactive highlights, active states, and call-to-actions. It provides a soft "glow" akin to a reading lamp.
- **Secondary (Deep Charcoal/Ebony):** Reserved for primary text and iconography to ensure maximum contrast against the parchment background.
- **Neutral (Parchment):** The foundation of the system. This off-white hue (#F9F7F2) reduces blue-light harshness.
- **Semantic Colors:** Success and Error states should be desaturated (e.g., a sage green or muted terracotta) to maintain the calming atmosphere.

## Typography
The typography is the soul of this design system. We utilize **Literata** for all long-form reading and headlines to provide a scholarly yet contemporary feel. Its vertical stress and generous x-height make it exceptionally comfortable for extended reading sessions.

**Plus Jakarta Sans** is used for UI metadata, labels, and navigation. This juxtaposition ensures that the "system" feels distinct from the "content."
- **Body Text:** Always prioritize a generous line-height (1.6x to 1.8x) to prevent lines from blurring together.
- **Contrast:** Maintain a high contrast ratio for body text, but avoid pure black (#000) to keep the look soft.

## Layout & Spacing
The layout follows a **Fixed Grid** philosophy on desktop to mimic the constraints of a book page, preventing line lengths from becoming too wide and difficult to scan.

- **Grid:** Use a 12-column grid for desktop with 24px gutters.
- **Reading Width:** Limit long-form text containers to a maximum of 720px for optimal readability.
- **Rhythm:** Use an 8px base unit. Generous vertical padding between sections (80px - 120px) is encouraged to maintain a sense of "quiet" in the interface.
- **Mobile:** Transition to a single-column layout with 20px side margins. Use card-based layouts to separate distinct literary works or categories.

## Elevation & Depth
Depth is achieved through **Tonal Layers** and **Ambient Shadows**, simulating the way physical paper stacks or books sit on a shelf.

- **Surfaces:** The base layer is the Parchment (#F9F7F2). Elevated elements (like cards or book covers) use a slightly lighter "Paper" color or a subtle white.
- **Shadows:** Use extremely soft, multi-layered shadows with a low opacity (4-8%) and a slight amber tint. This avoids "dirty" gray shadows and feels more natural in a warm-lit environment.
- **Interactions:** When hovering over a book cover, the shadow should slightly expand and soften, creating a "lift" effect.

## Shapes
The shape language is organic and soft. 
- **Corners:** Standard UI elements like buttons and input fields use a 0.5rem (8px) radius. 
- **Book Covers:** Should utilize a very slight 4px radius to mimic the subtle rounding of a hardcover book's spine and corners.
- **Containers:** Large content areas or "reading modes" should use the `rounded-xl` (1.5rem/24px) setting to create a friendly, protective frame around the text.

## Components
- **Buttons:** Primary buttons are filled with the soft Amber primary color. Use "Plus Jakarta Sans" in semi-bold for the label. Secondary buttons should be outlined with a thin 1px border in the secondary color.
- **Cards (Book Covers):** These are the hero components. They should feature a subtle inner-glow on the left edge to simulate a book spine and a soft drop shadow.
- **Input Fields:** Use a "minimalist desk" approach—a simple underline or a very light-tinted background with no heavy borders. Focus states should gently glow with an Amber underline.
- **Chips/Tags:** Use a lighter tint of the secondary color with serif text. These should look like small library labels or bookmarks.
- **Progress Indicators:** Use a thin, elegant line for reading progress, avoiding bulky bars.
- **The Bookmark:** A unique component that sits at the top right of a page or card, serving as a toggle for "Save for Later." It should feel like a physical fabric ribbon.