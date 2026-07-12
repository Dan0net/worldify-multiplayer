/**
 * Hide the Netlify deploy-preview bar/drawer.
 *
 * On `deploy-preview-*.netlify.app` (and branch) URLs Netlify injects a
 * collaboration/deploy bar as a direct child of <body>, usually after our app has
 * mounted — so a static CSS rule alone can miss it. We combine a CSS rule (for
 * anything present in the initial HTML) with a lightweight observer on <body>'s
 * direct children that hides any Netlify-branded node as it's injected.
 *
 * No-op everywhere the bar doesn't exist (local, production); safe to always call.
 */

const NETLIFY_RE = /netlify/i;

function looksLikeNetlify(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const cls = typeof node.className === 'string' ? node.className : '';
  const src = node.getAttribute?.('src') ?? '';
  return (
    NETLIFY_RE.test(node.id) ||
    NETLIFY_RE.test(cls) ||
    NETLIFY_RE.test(node.tagName) ||
    NETLIFY_RE.test(src)
  );
}

function hide(node: Node): void {
  if (node instanceof HTMLElement && looksLikeNetlify(node)) {
    node.style.setProperty('display', 'none', 'important');
  }
}

export function hideNetlifyPreviewBar(): void {
  // CSS for anything injected into the initial HTML / matchable by selector.
  const style = document.createElement('style');
  style.textContent =
    '[id*="netlify"],[class*="netlify"],iframe[src*="netlify"],netlify-drawer' +
    '{display:none !important;visibility:hidden !important;pointer-events:none !important;}';
  (document.head || document.documentElement).appendChild(style);

  const scanAndObserve = () => {
    // Hide anything already appended, then watch for late injection into <body>.
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
