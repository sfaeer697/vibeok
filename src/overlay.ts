/**
 * The on-screen VibeOK cursor, thought bubble, highlight box and score pill.
 *
 * Injected into every page with addInitScript. Everything lives in a closed Shadow DOM on
 * a host element with pointer-events:none, so it never blocks clicks, never inherits the
 * app's CSS, and its own updates are invisible to the app's DOM (and to VibeOK's
 * dead-button detector, which ignores the host).
 *
 * Kept as a plain string (not a serialized function) so bundlers can't rewrite it.
 */
export const OVERLAY_HOST_ID = "__vibeok-host";

export const OVERLAY_SCRIPT = String.raw`
(() => {
  if (window.top !== window || window.__vibeok) return;
  var HOST_ID = "${OVERLAY_HOST_ID}";
  var api = { ready: false, pending: [] };
  window.__vibeok = api;
  var root, cursor, bubble, box, hud, ripple, pos = { x: 40, y: 40 };

  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}",
    ".cursor{position:fixed;left:0;top:0;transform:translate(40px,40px);transition:transform .45s cubic-bezier(.22,1,.36,1);will-change:transform}",
    ".cursor svg{display:block;filter:drop-shadow(0 2px 4px rgba(17,24,39,.35))}",
    ".tag{position:absolute;left:22px;top:26px;background:#10B981;color:#fff;font-size:10px;font-weight:700;letter-spacing:.02em;padding:2px 6px;border-radius:999px;white-space:nowrap}",
    ".bubble{position:absolute;left:22px;top:52px;width:max-content;max-width:300px;background:#111827;color:#F9FAFB;font-size:13px;line-height:1.4;padding:8px 11px;border-radius:10px;box-shadow:0 6px 20px rgba(17,24,39,.25);opacity:0;transform:translateY(-4px);transition:opacity .2s,transform .2s;white-space:normal}",
    ".bubble.on{opacity:1;transform:none}",
    ".flip .bubble{left:auto;right:4px}",
    ".flip .tag{left:auto;right:4px}",
    ".box{position:fixed;border:2px solid #10B981;border-radius:8px;background:rgba(16,185,129,.08);opacity:0;transition:all .3s cubic-bezier(.22,1,.36,1);pointer-events:none}",
    ".box.on{opacity:1}",
    ".box.amber{border-color:#F59E0B;background:rgba(245,158,11,.12)}",
    ".box.red{border-color:#EF4444;background:rgba(239,68,68,.12)}",
    ".ripple{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:2px solid #10B981;opacity:0;pointer-events:none}",
    ".ripple.go{animation:rip .5s ease-out}",
    "@keyframes rip{from{opacity:.9;transform:scale(.3)}to{opacity:0;transform:scale(1.6)}}",
    ".hud{position:fixed;top:12px;right:12px;display:flex;gap:10px;align-items:center;background:#fff;color:#111827;border:1px solid #E5E7EB;border-radius:999px;padding:6px 12px;font-size:12px;box-shadow:0 4px 14px rgba(17,24,39,.12)}",
    ".dot{width:8px;height:8px;border-radius:50%;background:#10B981;animation:pulse 1.4s infinite}",
    "@keyframes pulse{50%{opacity:.35}}",
    ".hud b{font-weight:700}",
    ".sep{width:1px;height:12px;background:#E5E7EB}",
    ".bad{color:#DC2626}"
  ].join("");

  var CURSOR_SVG =
    '<svg width="29" height="34" viewBox="0 0 22 26" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M2 2 L2 21 L7.2 16.4 L10.6 24 L14 22.5 L10.7 15 L18 15 Z" fill="#10B981" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>' +
    '<circle cx="6.5" cy="9.5" r="1.6" fill="#fff"/></svg>';

  function mount() {
    if (document.getElementById(HOST_ID)) return;
    var host = document.createElement("vibeok-overlay");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    root = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);
    box = el("div", "box");
    ripple = el("div", "ripple");
    cursor = el("div", "cursor");
    cursor.innerHTML = CURSOR_SVG;
    var tag = el("div", "tag");
    tag.textContent = "VibeOK";
    cursor.appendChild(tag);
    bubble = el("div", "bubble");
    cursor.appendChild(bubble);
    hud = el("div", "hud");
    root.append(box, ripple, cursor, hud);
    cursor.style.transform = "translate(" + pos.x + "px," + pos.y + "px)";
    document.documentElement.appendChild(host);
    api.ready = true;
    var queued = api.pending;
    api.pending = [];
    queued.forEach(function (f) { f(); });
  }
  function el(tag, cls) { var e = document.createElement("div"); e.className = cls; return e; }
  function whenReady(f) { if (api.ready) f(); else api.pending.push(f); }

  api.move = function (x, y) {
    pos = { x: x, y: y };
    whenReady(function () {
      cursor.style.transform = "translate(" + x + "px," + y + "px)";
      cursor.className = x > window.innerWidth - 340 ? "cursor flip" : "cursor";
    });
  };
  api.say = function (text) {
    whenReady(function () {
      bubble.textContent = text || "";
      bubble.className = text ? "bubble on" : "bubble";
    });
  };
  api.mark = function (r, kind) {
    whenReady(function () {
      if (!r) { box.className = "box"; return; }
      box.style.left = r.x - 4 + "px";
      box.style.top = r.y - 4 + "px";
      box.style.width = r.width + 8 + "px";
      box.style.height = r.height + 8 + "px";
      box.className = "box on" + (kind === "amber" ? " amber" : kind === "red" ? " red" : "");
    });
  };
  api.ripple = function (x, y) {
    whenReady(function () {
      ripple.style.left = x + "px";
      ripple.style.top = y + "px";
      ripple.className = "ripple";
      void ripple.offsetWidth;
      ripple.className = "ripple go";
    });
  };
  api.hud = function (s) {
    whenReady(function () {
      hud.innerHTML = "";
      var dot = el("div", "dot");
      var a = document.createElement("span");
      a.innerHTML = "<b>VibeOK</b>";
      var b = document.createElement("span");
      b.textContent = "Pages " + s.pages;
      var c = document.createElement("span");
      c.textContent = "Clicked " + s.clicked;
      var d = document.createElement("span");
      d.textContent = "Issues " + s.issues;
      if (s.issues > 0) d.className = "bad";
      hud.append(dot, a, el("div", "sep"), b, el("div", "sep"), c, el("div", "sep"), d);
    });
  };

  // Init scripts run before <html> exists, so wait for the DOM.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
`;
