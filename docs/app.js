/* Kaaval page logic: the hero verdicts, the incident replays and a console running the real package in Pyodide. */
(() => {
  const $ = (id) => document.getElementById(id);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  // Colour the verdict word at the start of a decision; leave everything else as text.
  const fmt = (out) => esc(out).replace(/^(ALLOW|ASK|DENY)(\s)/gm, '<b class="$1">$1</b>$2').replace(/^(\s+\[NA-0\d\].*)$/gm, '<span class="f">$1</span>');

  /* ---------- hero: what the agent wants, and the answer ---------- */
  const stream = [
    ["rm -rf tests/ patches/ plan/ ~/", "DENY"], ["rm -rf tests/ patches/ plan/", "ALLOW"], ["rmdir /s /q d:\\", "DENY"],
    ["npm test", "ALLOW"], ["railway volume delete pocketos-prod-db", "DENY"], ["rm -rf $BUILD_DIR", "ASK"],
    ["git clean -fdx", "ALLOW"], ["DROP TABLE companies", "DENY"], ["find . -name '*.pyc' -delete", "ALLOW"],
  ];
  let si = 0;
  function nextVerdict() {
    const [c, v] = stream[si++ % stream.length];
    $("heroCmd").textContent = c;
    const p = $("heroVerdict");
    p.textContent = v[0] + v.slice(1).toLowerCase();
    p.className = "pill " + (v === "DENY" ? "bad" : v === "ALLOW" ? "allow" : "ask");
    window.Site && (Site.kaavalEvent = { cmd: c, verdict: v, at: performance.now() });
  }
  nextVerdict();
  if (!reduce) setInterval(nextVerdict, 2600);

  /* ---------- incidents ---------- */
  function renderIncidents(list) {
    $("incList").innerHTML = list.map((x) => `
      <article class="inc card" data-rise>
        <header><span class="no">${x.n}</span><h3>${esc(x.who)}</h3><span class="kind ${x.kind === "verbatim" ? "v" : ""}">${x.kind}</span></header>
        ${x.steps.map((s) => `<div class="run"><div class="c">${esc(s.cmd)}</div><div class="o">${fmt(s.out)}</div></div>`).join("")}
      </article>`).join("");
  }
  const order = ["09", "08", "06", "07", "10", "05"];
  renderIncidents(window.KAAVAL_INCIDENTS.slice().sort((a, b) => order.indexOf(a.n) - order.indexOf(b.n)));

  /* ---------- Pyodide: the real package, in this tab ---------- */
  const local = new URLSearchParams(location.search).get("pyodide") === "local";
  const PY_URL = local ? "./pyodide/" : "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
  let pyPromise = null, session = null;
  function loadPython() {
    if (pyPromise) return pyPromise;
    $("pyState").textContent = "loading python…";
    pyPromise = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = PY_URL + "pyodide.js"; s.onload = res; s.onerror = () => rej(new Error("couldn't load Pyodide"));
      document.head.append(s);
    }).then(() => loadPyodide({ indexURL: PY_URL })).then((py) => {
      py.FS.mkdirTree("/lib/kaaval");
      for (const [path, text] of Object.entries(window.KAAVAL_SRC)) py.FS.writeFile("/lib/" + path, text);
      py.runPython("import sys; sys.path.insert(0, '/lib'); import playground");
      session = py.runPython("playground.Session()");
      window.__py = py;
      $("pyState").textContent = `pyodide ${py.version} · ready`;
      $("pyState").classList.add("ok");
      return py;
    }).catch((e) => { $("pyState").textContent = "python failed to load"; pyPromise = null; throw e; });
    return pyPromise;
  }

  /* ---------- console ---------- */
  const out = $("conOut");
  function line(cls, html) { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; out.append(d); out.scrollTop = out.scrollHeight; return d; }
  line("sys", "Real kaaval, real Python. Type a command an agent might run, or `help`. Python loads the first time you run something (about 10 MB, once).");
  async function exec(cmd) {
    cmd = cmd.trim(); if (!cmd) return;
    line("c", esc(cmd));
    const o = line("o", "…");
    try {
      await loadPython();
      const r = session.run(cmd);
      o.innerHTML = fmt(String(r));
      const v = /^(ALLOW|ASK|DENY)/.exec(String(r));
      if (v && window.Site) Site.kaavalEvent = { cmd, verdict: v[1], at: performance.now() };
    } catch (e) { o.innerHTML = `<span class="f">${esc(e.message || String(e))}</span>`; }
    out.scrollTop = out.scrollHeight;
  }
  $("conForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("conIn").value; $("conIn").value = ""; exec(v); });
  document.querySelectorAll("[data-try]").forEach((b) => b.addEventListener("click", () => exec(b.dataset.try)));
  // warm Python up when the reader gets close to the console
  new IntersectionObserver((es, io) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); loadPython().catch(() => {}); } }, { rootMargin: "600px 0px" }).observe($("play"));

  $("rerun").addEventListener("click", async () => {
    $("rerunMsg").className = "msg"; $("rerunMsg").textContent = "loading python…";
    try {
      const py = await loadPython();
      const t = performance.now();
      const fresh = JSON.parse(py.runPython("playground.incidents()"));
      renderIncidents(fresh.sort((a, b) => order.indexOf(a.n) - order.indexOf(b.n)));
      const denied = fresh.filter((x) => x.steps[0].out.startsWith("DENY")).length;
      $("rerunMsg").className = "msg ok";
      $("rerunMsg").textContent = `Re-ran in ${Math.round(performance.now() - t)} ms with Pyodide ${py.version}: ${denied}/6 damaging actions denied.`;
      window.__check = { rerunDenied: denied };
    } catch (e) { $("rerunMsg").className = "msg bad"; $("rerunMsg").textContent = e.message; }
  });

  /* ---------- pinned rules ---------- */
  (function pin() {
    const sec = $("rules"), cards = $("cards");
    if (!window.gsap || !window.ScrollTrigger || reduce || innerWidth < 900) { sec.classList.add("no-pin"); return; }
    const dist = () => Math.max(0, cards.scrollWidth - innerWidth);
    gsap.to(cards, { x: () => -dist(), ease: "none",
      scrollTrigger: { trigger: "#hscroll", start: "top 12%", end: () => "+=" + dist(), pin: true, scrub: 0.8, invalidateOnRefresh: true, anticipatePin: 1 } });
  })();
})();
