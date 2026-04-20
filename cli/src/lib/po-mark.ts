// Editorial monogram — accent square with a reversed-out italic serif "P",
// echoing the masthead typography. Shared between two consumers so wi-65's
// mark swap lands in one place:
//
// 1. Dashboard header (inbox-serve.ts `renderPage`): wraps PO_MARK_SVG inside
//    a .po-mark container. Colors come from the page's CSS custom props
//    (--accent, --paper) and flip automatically in dark mode.
//
// 2. `/favicon.svg` route: serves PO_MARK_FAVICON_SVG standalone. Tab chrome
//    has no access to page CSS, so the favicon embeds its own <style> block
//    with a prefers-color-scheme media query — light tabs get the blue
//    accent, dark tabs get the lighter accent variant.
//
// Keep PO_MARK_INNER as the single source of truth for the geometry (the
// rect and glyph). Both wrappers compose it.

export const PO_MARK_INNER = `<rect class="po-mark__bg" x="0" y="0" width="32" height="32" rx="3" ry="3"/>
<text class="po-mark__glyph" x="16" y="23" text-anchor="middle" font-family="'Iowan Old Style','Palatino Linotype',Palatino,Georgia,ui-serif,serif" font-size="23" font-style="italic" font-weight="500">P</text>`;

export const PO_MARK_SVG = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  ${PO_MARK_INNER}
</svg>`;

// Standalone favicon. Fills must be baked in — browser tab chrome strips page
// CSS. Colors mirror the `--accent` / `--paper` pairs from inbox-serve.ts
// (light: #1a4fa8 on #ffffff; dark: #8fb6ff on #17191f).
export const PO_MARK_FAVICON_SVG = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <style>
    .po-mark__bg { fill: #1a4fa8; }
    .po-mark__glyph { fill: #ffffff; }
    @media (prefers-color-scheme: dark) {
      .po-mark__bg { fill: #8fb6ff; }
      .po-mark__glyph { fill: #17191f; }
    }
  </style>
  ${PO_MARK_INNER}
</svg>`;
