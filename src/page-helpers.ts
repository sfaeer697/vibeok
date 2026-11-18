import { OVERLAY_HOST_ID } from "./overlay.js";

/**
 * In-page helpers (window.__vibeokH), injected with addInitScript on every page.
 * Kept as a plain string so bundlers can't rewrite it.
 */
export const HELPERS_SCRIPT = String.raw`
(() => {
  if (window.__vibeokH) return;
  var HOST = "${OVERLAY_HOST_ID}";
  var SEL = 'button, [role="button"], input[type="submit"], input[type="button"], a[href="#"], a[href^="javascript:"], a:not([href]), summary';
  var H = {};

  function isVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  function label(el) {
    var t = el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "";
    t = String(t).replace(/\s+/g, " ").trim();
    if (!t) { var img = el.querySelector("img[alt]"); if (img) t = img.getAttribute("alt") || ""; }
    if (!t) { var svgt = el.querySelector("svg title"); if (svgt) t = svgt.textContent || ""; }
    return t.slice(0, 60) || "(icon button)";
  }
  function describe(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    var cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    var t = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return t ? s + ' ("' + t + '")' : s;
  }
  function candidates() {
    var out = [], seen = {};
    var els = document.querySelectorAll(SEL);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest("#" + HOST)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (!isVisible(el)) continue;
      if (el.tagName === "A" && !el.hasAttribute("href") && getComputedStyle(el).cursor !== "pointer") continue;
      var text = label(el);
      var base = el.tagName.toLowerCase() + "|" + text;
      var n = seen[base] || 0;
      seen[base] = n + 1;
      var form = el.form || el.closest("form");
      var type = (el.getAttribute("type") || "").toLowerCase();
      var isSubmit = !!form && (type === "submit" || (el.tagName === "BUTTON" && !type));
      out.push({ el: el, key: base + "|" + n, text: text, isSubmit: isSubmit, form: form });
    }
    return out;
  }
  function find(key) {
    var c = candidates();
    for (var i = 0; i < c.length; i++) if (c[i].key === key) return c[i];
    return null;
  }

  H.list = function () {
    return candidates().map(function (c) { return { key: c.key, text: c.text, isSubmit: c.isSubmit }; });
  };
  H.links = function () {
    var out = [];
    var as = document.querySelectorAll("a[href]");
    for (var i = 0; i < as.length; i++) {
      var href = as[i].href;
      if (/^https?:/i.test(href)) out.push(href);
    }
    return out;
  };
  H.prepare = function (key) {
    var c = find(key);
    if (!c) return false;
    c.el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return true;
  };
  H.rect = function (key) {
    var c = find(key);
    if (!c) return null;
    var r = c.el.getBoundingClientRect();
    var cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    var top = document.elementFromPoint(cx, cy);
    var covered = !top || !(top === c.el || c.el.contains(top));
    var formInvalid = !!(c.isSubmit && c.form && c.form.checkValidity && !c.form.checkValidity());
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: cx, cy: cy, covered: covered, formInvalid: formInvalid };
  };
  /** Tags the fields of the button's form so Playwright can fill them like a user would. */
  H.fields = function (key) {
    var c = find(key);
    if (!c || !c.form) return [];
    var out = [];
    var els = c.form.querySelectorAll("input, textarea, select");
    for (var i = 0; i < els.length; i++) {
      var f = els[i];
      var type = (f.getAttribute("type") || f.tagName).toLowerCase();
      if (["hidden", "submit", "button", "reset", "file", "image"].indexOf(type) >= 0) continue;
      if (f.disabled || f.readOnly || !isVisible(f)) continue;
      var id = "f" + Math.random().toString(36).slice(2, 9);
      f.setAttribute("data-vibeok-field", id);
      var hint = [f.name, f.id, f.getAttribute("placeholder"), f.getAttribute("aria-label"), f.getAttribute("autocomplete")]
        .filter(Boolean).join(" ").toLowerCase();
      out.push({ sel: '[data-vibeok-field="' + id + '"]', type: type, hint: hint, required: !!f.required, filled: !!f.value, checked: !!f.checked });
    }
    return out;
  };
  H.observe = function () {
    if (H._obs) H._obs.disconnect();
    var st = { n: 0, added: "" };
    var host = document.getElementById(HOST);
    var o = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (host && (m.target === host || host.contains(m.target))) continue;
        if (m.type === "attributes" && m.attributeName && m.attributeName.indexOf("data-vibeok") === 0) continue;
        if (m.type === "childList") {
          var nodes = Array.prototype.slice.call(m.addedNodes).concat(Array.prototype.slice.call(m.removedNodes));
          if (nodes.length && nodes.every(function (x) { return x === host; })) continue;
          for (var j = 0; j < m.addedNodes.length; j++) {
            var t = m.addedNodes[j].textContent;
            if (t && st.added.length < 600) st.added += " " + t.replace(/\s+/g, " ").trim();
          }
        }
        if (m.type === "characterData" && st.added.length < 600) st.added += " " + (m.target.textContent || "");
        st.n++;
      }
    });
    o.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    H._obs = o;
    H._st = st;
    H._href = location.href;
  };
  H.result = function () {
    var st = H._st || { n: 0, added: "" };
    if (H._obs) H._obs.disconnect();
    H._obs = null;
    // No _href means this is a new page: the click navigated.
    return { mutations: st.n, added: st.added.trim().slice(0, 600), href: location.href, startHref: H._href || null };
  };
  /** Finds a visible login or signup form (anything with a password field) and classifies it. */
  H.authForm = function () {
    var pws = Array.prototype.filter.call(document.querySelectorAll('input[type="password"]'), isVisible);
    if (!pws.length) return null;
    var form = pws[0].form || pws[0].closest("form");
    var submit = null;
    var cands = candidates();
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].isSubmit && (!form || cands[i].form === form)) { submit = cands[i]; break; }
    }
    var scope = form || document.body;
    var btn = (submit ? submit.text : "").toLowerCase();
    var all = ((scope.innerText || "") + " " + document.title + " " + location.pathname).toLowerCase();
    var kind;
    if (/sign ?up|create( an| your)? account|register|join|get started/.test(btn)) kind = "signup";
    else if (/log ?in|sign ?in/.test(btn)) kind = "login";
    else if (scope.querySelectorAll('input[type="password"]').length > 1 || /sign ?up|register|create( an| your)? account/.test(all)) kind = "signup";
    else kind = "login";
    return { kind: kind, submitKey: submit ? submit.key : null, submitText: submit ? submit.text : "" };
  };
  /**
   * Compact page reader for the journey agent: every visible interactive element gets a
   * number (data-vibeok-ref) and a role + accessible name, plus headings, messages and a
   * short slice of page text. Elements inside an open dialog come first.
   */
  H.snapshot = function (maxItems) {
    maxItems = maxItems || 80;
    var old = document.querySelectorAll("[data-vibeok-ref]");
    for (var i = 0; i < old.length; i++) old[i].removeAttribute("data-vibeok-ref");
    var SNAP = 'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [contenteditable="true"]';
    var els = Array.prototype.slice.call(document.querySelectorAll(SNAP));
    function inDialog(el) { return !!el.closest('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]'); }
    function fieldLabel(el) {
      var t = "";
      if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t = l.innerText; }
      if (!t) { var pl = el.closest("label"); if (pl) t = pl.innerText; }
      t = t || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "";
      return String(t).replace(/\s+/g, " ").trim().slice(0, 60);
    }
    function roleOf(el) {
      var r = el.getAttribute("role");
      if (r) return r;
      var tag = el.tagName.toLowerCase(), type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "a") return "link";
      if (tag === "select") return "select";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button" || type === "reset") return "button";
        if (type === "hidden" || type === "file" || type === "image") return "";
        return "textbox";
      }
      if (el.isContentEditable) return "textbox";
      return "button";
    }
    var items = [];
    var filtered = els.filter(function (el) {
      return !el.closest("#" + HOST) && isVisible(el) && roleOf(el);
    });
    var dialogOpen = filtered.some(inDialog);
    filtered.sort(function (a, b) { return Number(inDialog(b)) - Number(inDialog(a)); });
    for (var j = 0; j < filtered.length && items.length < maxItems; j++) {
      var el = filtered[j];
      var role = roleOf(el);
      var it = { ref: items.length + 1, role: role, name: "" };
      if (role === "textbox" || role === "select" || role === "checkbox" || role === "radio" || role === "combobox") {
        it.name = fieldLabel(el);
        var type = (el.getAttribute("type") || "").toLowerCase();
        if (type) it.type = type;
        if (role === "checkbox" || role === "radio") it.checked = !!el.checked || el.getAttribute("aria-checked") === "true";
        else if (role === "select") {
          it.value = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : "";
          it.options = Array.prototype.slice.call(el.options || [], 0, 10).map(function (o) { return o.text.trim(); });
        } else {
          var v = el.isContentEditable ? el.innerText : el.value;
          it.value = type === "password" ? (v ? "••••" : "") : String(v || "").slice(0, 60);
        }
        if (el.required) it.required = true;
      } else {
        it.name = label(el);
        if (role === "link") { try { var u = new URL(el.href); if (u.origin === location.origin) it.href = u.pathname; } catch (e) {} }
      }
      if (el.disabled || el.getAttribute("aria-disabled") === "true") it.disabled = true;
      if (dialogOpen && inDialog(el)) it.inDialog = true;
      el.setAttribute("data-vibeok-ref", String(it.ref));
      items.push(it);
    }
    function texts(sel, max) {
      var out = [];
      var n = document.querySelectorAll(sel);
      for (var k = 0; k < n.length && out.length < max; k++) {
        if (n[k].closest("#" + HOST) || !isVisible(n[k])) continue;
        var t = (n[k].innerText || "").replace(/\s+/g, " ").trim();
        if (t && out.indexOf(t) < 0) out.push(t.slice(0, 140));
      }
      return out;
    }
    var body = (document.body && document.body.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
    return {
      path: location.pathname + location.search,
      title: document.title,
      headings: texts("h1, h2, h3", 8),
      messages: texts('[role="alert"], [role="status"], [aria-live], .toast, [class*="toast"], [class*="alert"], [class*="error"], [class*="notification"]', 6),
      dialog: dialogOpen,
      text: body.slice(0, 1500),
      items: items,
      total: filtered.length,
    };
  };
  H.hasText = function (needle) {
    var norm = function (s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); };
    // Page text only, not what's typed in inputs: a value still sitting in the form isn't proof it was saved.
    var hay = norm(document.body && document.body.innerText);
    return hay.indexOf(norm(needle)) >= 0;
  };
  H.pageText = function () { return (document.body && document.body.innerText || "").slice(0, 3000); };
  H.ripple = function (x, y) { if (window.__vibeok) window.__vibeok.ripple(x, y); };
  /** At the current viewport: is the page wider than the screen, and which elements cause it? */
  H.overflow = function () {
    var vw = document.documentElement.clientWidth;
    var sw = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
    if (sw <= vw + 2 || !document.body) return null;
    var offenders = [];
    var all = document.body.querySelectorAll("*");
    for (var i = 0; i < all.length && offenders.length < 400; i++) {
      var el = all[i];
      if (el.closest("#" + HOST)) continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= vw + 2) continue;
      var clipped = false;
      for (var p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== "visible") { clipped = true; break; }
      }
      if (!clipped) offenders.push(el);
    }
    function innermost(list) {
      return list.filter(function (e) { return !list.some(function (o) { return o !== e && e.contains(o); }); });
    }
    var wide = offenders.filter(function (e) { return e.getBoundingClientRect().width > vw + 2; });
    var pick = wide.length ? innermost(wide) : innermost(offenders);
    pick.sort(function (a, b) { return b.getBoundingClientRect().right - a.getBoundingClientRect().right; });
    return {
      viewport: vw,
      pageWidth: sw,
      elements: pick.slice(0, 3).map(function (e) {
        return describe(e) + " is " + Math.round(e.getBoundingClientRect().width) + "px wide";
      }),
    };
  };
  window.__vibeokH = H;
})();
`;
