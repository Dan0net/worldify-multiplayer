/**
 * Hide foreign UI injected into the page — chiefly Netlify's deploy-preview
 * collaboration bar/drawer.
 *
 * This app owns the entire viewport: everything we render lives inside `#root`,
 * and the WebGL canvas is `#game-canvas` (appended to <body> by GameCore). On
 * `deploy-preview-*.netlify.app` URLs Netlify injects a *fixed, bottom-pinned*
 * bar as a direct child of <body>, usually after mount. Our old selector only
 * matched nodes literally containing "netlify" in their id/class/tag/src, so a
 * generically-named (or shadow-DOM) bar slipped through — and being pinned to
 * the bottom it overlapped and blocked our bottom controls (build hotbar,
 * Worlds/Settings buttons).
 *
 * Since we control the whole page, the robust rule is: hide every *foreign*
 * direct child of <body> — anything that isn't our root, our canvas, or a
 * non-visual head-ish tag (script/style/link/…). No-op on local/production
 * where nothing foreign is injected.
 */

// Our own body children + non-visual tags we must never touch.
const KEEP_IDS = new Set(['root', 'game-canvas']);
const KEEP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE',
  // Vite's dev-mode error overlay — keep it usable locally.
  'VITE-ERROR-OVERLAY',
]);

/** A direct <body> child that isn't ours and isn't a non-visual tag. */
function isForeign(node: Node): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  if (node.id && KEEP_IDS.has(node.id)) return false;
  if (KEEP_TAGS.has(node.tagName)) return false;
  return true;
}

function hide(node: Node): void {
  if (isForeign(node)) {
    node.style.setProperty('display', 'none', 'important');
    node.style.setProperty('pointer-events', 'none', 'important');
  }
}

export function hideNetlifyPreviewBar(): void {
  // Static CSS fallback for anything present in the initial HTML or matchable
  // by a netlify-branded selector anywhere in the document (covers nested nodes
  // the body-child observer below wouldn't see).
  const style = document.createElement('style');
  style.textContent =
    '[id*="netlify"],[class*="netlify"],iframe[src*="netlify"],netlify-drawer' +
    '{display:none !important;visibility:hidden !important;pointer-events:none !important;}';
  (document.head || document.documentElement).appendChild(style);

  const scanAndObserve = () => {
    // Hide anything foreign already present, then watch for late injection.
    document.body.childNodes.forEach(hide);
    const obs = new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach(hide);
    });
    obs.observe(document.body, { childList: true });
    // The bar injects early; stop watching after a while to avoid lingering overhead.
    setTimeout(() => obs.disconnect(), 20000);
  };

  if (document.body) scanAndObserve();
  else document.addEventListener('DOMContentLoaded', scanAndObserve, { once: true });
}
