/*
  BFCM 2026 free gifts.
  Adds the configured gift products to the cart (qty 1, hidden property _bf_gift)
  while they are eligible, and removes them when they are not:
    - now is inside one of the gift's date ranges (theme settings, one per line:
      "2026-11-20 00:00 to 2026-11-20 23:59", in the store's UTC offset)
    - the cart has at least one paid item and the paid subtotal >= minSubtotal
    - if the gift has a required discount code, that code is on the cart
  Gift products should be priced $0 (compare-at = the value shown struck through).
  Config comes from snippets/bf-free-gifts.liquid (window.bfFreeGifts).
*/
(function () {
  const config = window.bfFreeGifts;
  if (!config || !Array.isArray(config.gifts) || config.gifts.length === 0) return;

  const GIFT_PROP = '_bf_gift';
  const nativeFetch = window.fetch.bind(window);
  const root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
  let running = false;
  let queued = false;

  function parseWhen(text) {
    const m = String(text).trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
    if (!m) return NaN;
    const hh = (m[2] || '00').padStart(2, '0');
    const mm = m[3] || '00';
    return Date.parse(`${m[1]}T${hh}:${mm}:00${config.utcOffset || '+11:00'}`);
  }

  function inWindow(dates, now) {
    // In the theme editor, show gifts regardless of date so they can be previewed.
    if (config.preview) return true;
    return String(dates || '')
      .split(/\n|;/)
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => {
        const [startText, endText] = line.split(/\s+to\s+/i);
        const start = parseWhen(startText);
        let end = endText ? parseWhen(endText) : NaN;
        if (Number.isNaN(start)) return false;
        // An end with no time covers the whole day; an end time covers that minute.
        if (!Number.isNaN(end)) end += /\d:\d\d$/.test(endText.trim()) ? 60 * 1000 : 24 * 60 * 60 * 1000;
        return now >= start && (Number.isNaN(end) || now < end);
      });
  }

  function cartCodes(cart) {
    return (cart.discount_codes || [])
      .filter((d) => d.applicable !== false)
      .map((d) => String(d.code).toUpperCase());
  }

  function isGiftLine(item) {
    return item.properties && item.properties[GIFT_PROP];
  }

  async function getCart() {
    const res = await nativeFetch(`${root}cart.js`, { headers: { Accept: 'application/json' } });
    return res.json();
  }

  async function post(path, body) {
    const res = await nativeFetch(`${root}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function sync() {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    let changed = false;
    try {
      const cart = await getCart();
      const now = Date.now();
      const paid = cart.items.filter((item) => !isGiftLine(item));
      const paidSubtotal = paid.reduce((sum, item) => sum + item.final_line_price, 0);
      const hasPaid = paid.length > 0 && paidSubtotal >= (config.minSubtotal || 0);
      const codes = cartCodes(cart);

      const eligible = new Set(
        config.gifts
          .filter((gift) => hasPaid && inWindow(gift.dates, now))
          .filter((gift) => !gift.code || codes.includes(String(gift.code).trim().toUpperCase()))
          .map((gift) => Number(gift.variant))
      );

      // Remove or fix gift lines (by line key, so paid lines of the same variant are untouched).
      const seen = new Set();
      const updates = {};
      cart.items.forEach((item) => {
        if (!isGiftLine(item)) return;
        const keep = eligible.has(item.variant_id) && !seen.has(item.variant_id);
        seen.add(item.variant_id);
        if (!keep) updates[item.key] = 0;
        else if (item.quantity !== 1) updates[item.key] = 1;
      });
      if (Object.keys(updates).length) {
        await post('cart/update.js', { updates });
        changed = true;
      }

      const toAdd = [...eligible].filter((variant) => !seen.has(variant));
      if (toAdd.length) {
        await post('cart/add.js', {
          items: toAdd.map((id) => ({ id, quantity: 1, properties: { [GIFT_PROP]: 'BFCM 2026' } })),
        });
        changed = true;
      }

      if (changed) await refresh();
    } catch (e) {
      console.error('[bf-free-gifts]', e);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        sync();
      }
    }
  }

  async function refresh() {
    // Full cart page: simplest and safest is a reload (only happens when a gift changes).
    if (document.getElementById('main-cart-items')) {
      window.location.reload();
      return;
    }

    const res = await nativeFetch(`${root}?sections=cart-drawer,cart-icon-bubble`);
    const sections = await res.json();
    const parser = new DOMParser();

    const drawer = document.querySelector('cart-drawer');
    if (drawer && sections['cart-drawer']) {
      const html = parser.parseFromString(sections['cart-drawer'], 'text/html');
      const fresh = html.querySelector('cart-drawer');
      const inner = drawer.querySelector('#CartDrawer');
      const freshInner = html.querySelector('#CartDrawer');
      if (inner && freshInner) inner.innerHTML = freshInner.innerHTML;
      if (fresh) drawer.classList.toggle('is-empty', fresh.classList.contains('is-empty'));
      const overlay = drawer.querySelector('#CartDrawer-Overlay');
      if (overlay) overlay.addEventListener('click', drawer.close.bind(drawer));
    }

    const bubble = document.getElementById('cart-icon-bubble');
    if (bubble && sections['cart-icon-bubble']) {
      const html = parser.parseFromString(sections['cart-icon-bubble'], 'text/html');
      const fresh = html.querySelector('.shopify-section');
      if (fresh) bubble.innerHTML = fresh.innerHTML;
    }
  }

  let timer;
  function scheduleSync(delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(sync, delay);
  }

  // Catch every cart change on the page (Dawn, Foxify and app add-to-carts),
  // not just the ones that publish Dawn's cart-update event.
  const CART_CHANGE = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const result = nativeFetch(input, init);
    if (url && CART_CHANGE.test(url.split('#')[0])) {
      result.then(() => scheduleSync(), () => {});
    }
    return result;
  };

  if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
    subscribe(PUB_SUB_EVENTS.cartUpdate, () => scheduleSync());
  }

  // Re-check on load and when a tab comes back into view (date windows open/close).
  scheduleSync(0);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync();
  });
})();
