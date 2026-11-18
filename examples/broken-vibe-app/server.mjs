// A small "vibe-coded" app with bugs planted on purpose, so you can watch VibeOK find them.
// No dependencies:  node examples/broken-vibe-app/server.mjs   then   npx vibeok localhost:3000
//
// Planted bugs (VibeOK should find all of them):
//   1. Home: uncaught TypeError on load (analytics.track on an undefined object)
//   2. Home: "Watch demo" button does nothing (dead button)
//   3. Home: feature strip is 1100px wide, so the page scrolls sideways on phones
//   4. Nav: link to /about returns 404
//   5. Signup: POST /api/signup returns 500, but the form shows "Account created!"
//   6. Dashboard: "Export CSV" button does nothing (dead button)
//   7. Dashboard: "Invite team" only shows a "Coming soon" alert (placeholder)
//   8. Pricing: "Upgrade" calls POST /api/checkout, which returns 404
//   9. Behind login (/app): "Save settings" gets a 500 and the page shows nothing
//      Log in at /login with demo@taskpilot.dev / demo1234
//  10. Behind login (/projects): "Create project" shows the new project, but it's never
//      saved, so it's gone after a reload. Only a journey catches this one:
//        npx vibeok "log in, create a project called Launch, and check it's still there after a reload"
// /notes saves correctly; journeys on it should pass.
// /healthy is a page with no bugs, used by the tests to check for false positives.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 3000);

const css = `
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#FAF8F5;color:#111827}
nav{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;padding:16px 28px;border-bottom:1px solid #E5E7EB;background:#fff}
nav a{color:#4B5563;text-decoration:none;font-size:14px}nav b{margin-right:auto}
main{max-width:960px;margin:0 auto;padding:40px 24px}
h1{font-size:40px;letter-spacing:-.02em;margin:0 0 12px}p{color:#4B5563}
.btn{display:inline-block;border:0;border-radius:12px;padding:11px 18px;font-size:15px;font-weight:600;cursor:pointer;background:#111827;color:#fff;margin:6px 8px 6px 0}
.btn.alt{background:#fff;color:#111827;border:1px solid #E5E7EB}
.card{background:#fff;border:1px solid #E5E7EB;border-radius:16px;padding:20px;margin:16px 0}
.strip{display:flex;gap:16px;width:1100px}.strip .card{flex:0 0 340px}
form{display:grid;gap:10px;max-width:360px}input{padding:10px 12px;border:1px solid #E5E7EB;border-radius:10px;font-size:15px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#10B981;color:#fff;padding:10px 16px;border-radius:10px}
.modal{position:fixed;inset:0;background:rgba(17,24,39,.4);display:grid;place-items:center}.modal .card{min-width:300px}
.dark{background:#111827;color:#F9FAFB}
`;

const nav = `<nav><b>TaskPilot</b><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/dashboard">Dashboard</a><a href="/about">About</a><a href="/signup">Sign up</a><a href="/login">Log in</a><a href="/notes">Notes</a></nav>`;

const page = (title, body, script = "", withNav = true) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · TaskPilot</title><style>${css}</style></head>
<body>${withNav ? nav : ""}<main>${body}</main><script>${script}</script></body></html>`;

const pages = {
  "/": page(
    "Home",
    `<h1>Plan your week in 30 seconds</h1>
     <p>TaskPilot turns your messy to-do list into a calm, realistic plan.</p>
     <a class="btn" href="/signup">Get started</a>
     <button class="btn alt" id="demo">Watch demo</button>
     <div class="strip">
       <div class="card"><b>Smart scheduling</b><p>Drops tasks into the gaps in your calendar.</p></div>
       <div class="card"><b>Focus mode</b><p>One task at a time, no noise.</p></div>
       <div class="card"><b>Weekly review</b><p>See what moved and what didn't.</p></div>
     </div>`,
    `// Bug 1: analytics was never initialised
     window.analytics.track("home_view");
     // Bug 2: the demo button was generated with an empty handler
     document.getElementById("demo").addEventListener("click", () => {});`,
  ),
  "/signup": page(
    "Sign up",
    `<h1>Create your account</h1>
     <form id="f">
       <input name="name" placeholder="Your name" required>
       <input name="email" type="email" placeholder="Email" required>
       <input name="password" type="password" placeholder="Password" required minlength="8">
       <button class="btn" type="submit">Create account</button>
     </form>`,
    `document.getElementById("f").addEventListener("submit", async (e) => {
       e.preventDefault();
       // Bug 5: the response is never checked, so a 500 still shows success
       await fetch("/api/signup", { method: "POST", headers: { "content-type": "application/json" },
         body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
       const t = document.createElement("div"); t.className = "toast"; t.textContent = "Account created! Welcome aboard.";
       document.body.appendChild(t);
     });`,
  ),
  "/dashboard": page(
    "Dashboard",
    `<h1>Your workspace</h1>
     <div class="card"><b>This week</b><p id="stats">12 tasks · 4 done</p>
       <button class="btn alt" id="refresh">Refresh</button>
       <button class="btn alt" id="export">Export CSV</button>
       <button class="btn alt" id="invite">Invite team</button>
       <button class="btn alt" id="theme" aria-pressed="false">Dark mode</button>
       <button class="btn" id="new">New project</button>
       <button class="btn alt" id="del">Delete workspace</button>
     </div>`,
    `document.getElementById("refresh").onclick = async () => {
       const r = await fetch("/api/stats"); const d = await r.json();
       document.getElementById("stats").textContent = d.total + " tasks · " + d.done + " done";
     };
     // Bug 6: Export CSV was never implemented
     document.getElementById("export").onclick = () => { /* TODO */ };
     // Bug 7: placeholder feature
     document.getElementById("invite").onclick = () => alert("Coming soon!");
     document.getElementById("theme").onclick = (e) => {
       document.body.classList.toggle("dark");
       e.target.setAttribute("aria-pressed", String(document.body.classList.contains("dark")));
     };
     document.getElementById("new").onclick = () => {
       const m = document.createElement("div"); m.className = "modal";
       m.innerHTML = '<div class="card"><b>New project</b><p>Name it later.</p></div>';
       document.body.appendChild(m);
     };
     document.getElementById("del").onclick = () => { if (confirm("Delete everything?")) fetch("/api/workspace", { method: "DELETE" }); };`,
  ),
  "/pricing": page(
    "Pricing",
    `<h1>Simple pricing</h1>
     <div class="card"><b>Pro · $9/month</b><p>Unlimited projects and focus sessions.</p>
       <button class="btn" id="up">Upgrade</button></div>`,
    `document.getElementById("up").onclick = async () => {
       // Bug 8: the checkout route was renamed but this call wasn't
       const r = await fetch("/api/checkout", { method: "POST" });
       if (!r.ok) console.warn("checkout failed");
     };`,
  ),
  "/login": page(
    "Log in",
    `<h1>Welcome back</h1>
     <p>Demo account: demo@taskpilot.dev / demo1234</p>
     <form id="f">
       <input name="email" type="email" placeholder="Email" required>
       <input name="password" type="password" placeholder="Password" required>
       <button class="btn" type="submit">Log in</button>
       <p id="err" style="color:#DC2626"></p>
     </form>`,
    `document.getElementById("f").addEventListener("submit", async (e) => {
       e.preventDefault();
       const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" },
         body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
       if (r.ok) location.href = new URLSearchParams(location.search).get("next") || "/app";
       else document.getElementById("err").textContent = "Wrong email or password.";
     });`,
  ),
  "/app": page(
    "Settings",
    `<h1>Account settings</h1>
     <form id="s" class="card">
       <input name="displayName" placeholder="Display name" required>
       <button class="btn" type="submit">Save settings</button>
     </form>
     <a class="btn alt" href="/projects">Your projects</a>
     <button class="btn alt" id="out">Log out</button>`,
    `// Bug 9: the 500 is ignored and nothing tells the user
     document.getElementById("s").addEventListener("submit", async (e) => {
       e.preventDefault();
       await fetch("/api/settings", { method: "POST", body: new FormData(e.target) });
     });
     document.getElementById("out").onclick = async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/"; };`,
  ),
  "/healthy": page(
    "Healthy",
    `<h1>Everything works here</h1>
     <button class="btn" id="a">Load stats</button>
     <button class="btn alt" id="b">Toggle details</button>
     <p id="details" hidden>Details are visible.</p>
     <a class="btn alt" href="/healthy?again=1">Reload this page</a>`,
    `document.getElementById("a").onclick = async () => {
       const r = await fetch("/api/stats"); const d = await r.json(); document.getElementById("a").textContent = d.total + " tasks";
     };
     document.getElementById("b").onclick = () => { const d = document.getElementById("details"); d.hidden = !d.hidden; };`,
    false,
  ),
};

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const notes = ["Buy coffee beans"];
const projects = ["Website redesign"]; // bug 10: new projects never get added here

const projectsPage = () => page(
  "Projects",
  `<h1>Your projects</h1>
   <ul id="list">${projects.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
   <form id="np" class="card">
     <label for="pname">Project name</label>
     <input id="pname" name="name" required>
     <button class="btn" type="submit">Create project</button>
   </form>`,
  `document.getElementById("np").addEventListener("submit", async (e) => {
     e.preventDefault();
     const name = new FormData(e.target).get("name");
     const r = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
     if (r.ok) {
       const li = document.createElement("li"); li.textContent = name; document.getElementById("list").appendChild(li);
       e.target.reset();
     }
   });`,
);

const notesPage = () => page(
  "Notes",
  `<h1>Notes</h1>
   <ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
   <form id="nf" class="card">
     <label for="note">New note</label>
     <input id="note" name="text" required>
     <button class="btn" type="submit">Add note</button>
   </form>`,
  `document.getElementById("nf").addEventListener("submit", async (e) => {
     e.preventDefault();
     const text = new FormData(e.target).get("text");
     const r = await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
     if (r.ok) location.reload(); else alert("Couldn't save the note");
   });`,
);

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const loggedIn = (req) => /(?:^|;\s*)sid=demo-session(?:;|$)/.test(req.headers.cookie || "");
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  if (req.method === "POST" && pathname === "/api/login") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (body.email === "demo@taskpilot.dev" && body.password === "demo1234") {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=demo-session; Path=/; HttpOnly; SameSite=Lax" });
      return res.end('{"ok":true}');
    }
    return json(res, 401, { error: "Invalid credentials" });
  }
  if (req.method === "POST" && pathname === "/api/logout") {
    res.writeHead(200, { "set-cookie": "sid=; Path=/; Max-Age=0" });
    return res.end();
  }
  if (pathname === "/app" && !loggedIn(req)) {
    res.writeHead(302, { location: "/login?next=/app" });
    return res.end();
  }
  if ((pathname === "/projects" || pathname === "/api/projects") && !loggedIn(req)) {
    if (pathname === "/api/projects") return json(res, 401, { error: "Log in first" });
    res.writeHead(302, { location: "/login?next=/projects" });
    return res.end();
  }
  if (pathname === "/projects") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(projectsPage());
  }
  if (req.method === "POST" && pathname === "/api/projects") {
    await readBody(req); // bug 10: accepted, never stored
    return json(res, 201, { ok: true });
  }
  if (pathname === "/notes") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(notesPage());
  }
  if (req.method === "POST" && pathname === "/api/notes") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (body.text) notes.push(String(body.text).slice(0, 200));
    return json(res, 201, { ok: true });
  }
  if (req.method === "POST" && pathname === "/api/settings") {
    return json(res, 500, { error: "TypeError: Cannot read properties of null (reading 'userId')" });
  }
  if (req.method === "POST" && pathname === "/api/signup") {
    return json(res, 500, { error: "PrismaClientValidationError: Argument `bio` must not be null." });
  }
  if (pathname === "/api/stats") return json(res, 200, { total: 12, done: 5 });
  if (pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
  const html = pages[pathname];
  if (html) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  if (pathname.startsWith("/api/")) return json(res, 404, { error: "Not found" });
  res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  res.end(page("Not found", "<h1>404</h1><p>This page could not be found.</p>"));
}).listen(PORT, () => console.log(`Broken vibe app running at http://localhost:${PORT}`));
