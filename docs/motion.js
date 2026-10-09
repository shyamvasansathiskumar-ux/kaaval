/* Motion layer shared by the project sites: preloader, smooth scroll, text reveals,
   marquee, magnetic buttons, cursor, chapter rail and the scroll "stage" the 3D world follows.
   Everything here is enhancement: without it the page is complete and readable. */
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const Site = (window.Site = window.Site || {});
  Site.stage = 0; Site.progress = 0; Site.velocity = 0; Site.reduce = reduce;
  const ready = [];
  Site.onReady = (fn) => ready.push(fn);

  const hasGsap = !!window.gsap;
  if (hasGsap) gsap.registerPlugin(...[window.ScrollTrigger, window.SplitText, window.ScrambleTextPlugin].filter(Boolean));

  /* ---------- smooth scroll ---------- */
  let lenis = null;
  if (!reduce && window.Lenis && hasGsap) {
    lenis = new Lenis({ lerp: 0.1, smoothWheel: true, wheelMultiplier: 0.95,
      // let inner scroll areas (tables, consoles, text boxes) scroll themselves
      prevent: (node) => !!(node.closest && node.closest("[data-lenis-prevent], textarea, .vectors, .con-out, .scroll-y")) });
    Site.lenis = lenis;
    lenis.on("scroll", (e) => { ScrollTrigger.update(); Site.velocity = e.velocity || 0; });
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const id = a.getAttribute("href");
    if (id.length < 2) return;
    const el = document.querySelector(id);
    if (!el) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(el, { offset: -10, duration: 1.4 }); else el.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
    history.replaceState(null, "", id);
  });

  /* ---------- global progress + nav state ---------- */
  const nav = document.querySelector(".nav");
  let lastY = 0;
  function onScroll() {
    const y = scrollY, H = document.documentElement.scrollHeight - innerHeight;
    Site.progress = H > 0 ? y / H : 0;
    if (nav) {
      nav.classList.toggle("scrolled", y > 40);
      nav.classList.toggle("hide", y > 400 && y > lastY + 2 && !document.body.classList.contains("menu-open"));
      if (y < lastY - 2) nav.classList.remove("hide");
    }
    lastY = y;
  }
  addEventListener("scroll", onScroll, { passive: true }); onScroll();

  /* ---------- stage: which chapter the 3D world should be showing ---------- */
  const stages = [...document.querySelectorAll("[data-stage]")];
  // Stage n is reached when section n's top crosses 55% of the viewport (stage 0 at the very top),
  // and the value moves smoothly from one section's anchor to the next.
  function computeStage() {
    if (!stages.length) return;
    const y = scrollY, mid = innerHeight * 0.55;
    const anchors = stages.map((el, k) => (k === 0 ? 0 : el.getBoundingClientRect().top + y - mid));
    let s = 0;
    for (let k = 0; k < stages.length; k++) {
      const a = anchors[k], b = k + 1 < anchors.length ? anchors[k + 1] : a + stages[k].offsetHeight;
      if (y >= a) s = +stages[k].dataset.stage + Math.min(1, (y - a) / Math.max(1, b - a));
    }
    Site.stage = s;
  }
  addEventListener("scroll", computeStage, { passive: true }); addEventListener("resize", computeStage); computeStage();
  // Programmatic and smooth scrolls don't always fire a scroll event: also check every frame.
  let seenY = -1;
  (function watch() { if (scrollY !== seenY) { seenY = scrollY; computeStage(); onScroll(); } requestAnimationFrame(watch); })();

  /* ---------- chapter rail ---------- */
  const chapters = [...document.querySelectorAll("[data-chapter]")];
  const rail = document.querySelector(".rail");
  if (rail && chapters.length) {
    chapters.forEach((c) => {
      const li = document.createElement("li"), a = document.createElement("a");
      a.href = "#" + c.id; a.innerHTML = `<span>${c.dataset.chapter}</span><i></i>`;
      a.setAttribute("aria-label", c.dataset.chapter);
      li.append(a); rail.append(li);
    });
    const links = [...rail.querySelectorAll("a")];
    const upd = () => {
      let cur = 0;
      chapters.forEach((c, k) => { if (c.getBoundingClientRect().top < innerHeight * 0.5) cur = k; });
      links.forEach((a, k) => a.classList.toggle("on", k === cur));
    };
    addEventListener("scroll", upd, { passive: true }); upd();
  }

  /* ---------- cursor ---------- */
  if (fine && !reduce) {
    const cur = document.createElement("div"); cur.className = "cursor"; document.body.append(cur);
    let x = -100, y = -100, cx = x, cy = y;
    addEventListener("pointermove", (e) => { x = e.clientX; y = e.clientY; cur.classList.add("on"); }, { passive: true });
    document.addEventListener("pointerover", (e) => cur.classList.toggle("hot", !!e.target.closest("a, button, [data-hot], input, select, textarea")));
    document.addEventListener("pointerleave", () => cur.classList.remove("on"));
    (function loop() { cx += (x - cx) * 0.22; cy += (y - cy) * 0.22; cur.style.transform = `translate3d(${cx}px, ${cy}px, 0)`; requestAnimationFrame(loop); })();
  }
  Site.pointer = { x: 0, y: 0 };
  addEventListener("pointermove", (e) => { Site.pointer.x = (e.clientX / innerWidth) * 2 - 1; Site.pointer.y = (e.clientY / innerHeight) * 2 - 1; }, { passive: true });

  /* ---------- magnetic buttons ---------- */
  if (fine && !reduce && hasGsap) {
    document.querySelectorAll(".btn, [data-magnetic]").forEach((b) => {
      const xTo = gsap.quickTo(b, "x", { duration: 0.6, ease: "elastic.out(1, .4)" });
      const yTo = gsap.quickTo(b, "y", { duration: 0.6, ease: "elastic.out(1, .4)" });
      b.addEventListener("pointermove", (e) => {
        const r = b.getBoundingClientRect();
        xTo((e.clientX - r.left - r.width / 2) * 0.28); yTo((e.clientY - r.top - r.height / 2) * 0.38);
      });
      b.addEventListener("pointerleave", () => { xTo(0); yTo(0); });
    });
  }

  /* ---------- marquee: drifts on its own, scroll speed pushes it ---------- */
  if (hasGsap) document.querySelectorAll(".marquee .track").forEach((t) => {
    t.innerHTML += t.innerHTML;
    if (reduce) return;
    const tw = gsap.to(t, { xPercent: -50, ease: "none", duration: +(t.dataset.speed || 38), repeat: -1 });
    let dir = 1;
    ScrollTrigger.create({ onUpdate: (self) => {
      const v = self.getVelocity() / 400;
      if (self.direction !== dir) dir = self.direction;
      gsap.to(tw, { timeScale: (1 + Math.min(4, Math.abs(v))) * dir, duration: 0.2, overwrite: true });
      gsap.to(tw, { timeScale: dir, duration: 1.2, delay: 0.25, overwrite: false });
    } });
  });

  /* ---------- reveals (after fonts so lines split where they'll stay) ---------- */
  function reveals() {
    if (!hasGsap || reduce) return;
    document.querySelectorAll("[data-split]").forEach((el) => {
      if (!window.SplitText) return;
      SplitText.create(el, {
        type: "lines", mask: "lines", linesClass: "split-line", autoSplit: true,
        onSplit: (self) => gsap.from(self.lines, {
          yPercent: 110, rotate: 2, duration: 1.25, stagger: 0.09, ease: "expo.out",
          scrollTrigger: { trigger: el, start: "top 86%", once: true },
        }),
      });
    });
    document.querySelectorAll("[data-scramble]").forEach((el) => {
      if (!window.ScrambleTextPlugin) return;
      const text = el.textContent;
      ScrollTrigger.create({ trigger: el, start: "top 92%", once: true, onEnter: () =>
        gsap.to(el, { duration: 1.1, scrambleText: { text, chars: "01ABCDEF▚▞/\\_", speed: 0.6, revealDelay: 0.15 } }) });
    });
    document.querySelectorAll("[data-rise]").forEach((el) => {
      gsap.from(el, { y: 48, opacity: 0, duration: 1.2, ease: "expo.out", delay: +(el.dataset.rise || 0),
        scrollTrigger: { trigger: el, start: "top 90%", once: true } });
    });
    document.querySelectorAll("[data-stagger]").forEach((el) => {
      gsap.from(el.children, { y: 40, opacity: 0, duration: 1.1, ease: "expo.out", stagger: 0.08,
        scrollTrigger: { trigger: el, start: "top 86%", once: true } });
    });
    document.querySelectorAll("[data-count]").forEach((el) => {
      const end = +el.dataset.count, dec = +(el.dataset.dec || 0), o = { v: 0 };
      ScrollTrigger.create({ trigger: el, start: "top 90%", once: true, onEnter: () =>
        gsap.to(o, { v: end, duration: 1.8, ease: "power3.out", onUpdate: () => (el.textContent = o.v.toFixed(dec)) }) });
    });
    document.querySelectorAll("[data-parallax]").forEach((el) => {
      gsap.to(el, { yPercent: +el.dataset.parallax, ease: "none", scrollTrigger: { trigger: el, start: "top bottom", end: "bottom top", scrub: true } });
    });
  }

  /* ---------- preloader → hero intro ---------- */
  const loader = document.querySelector(".loader");
  const worldReady = new Promise((res) => { Site.worldReady = res; setTimeout(res, 4000); });
  const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
  function intro() {
    const heroBits = document.querySelectorAll("[data-intro]");
    if (!hasGsap || reduce) { loader && loader.remove(); return; }
    const tl = gsap.timeline();
    if (loader) tl.to(loader, { clipPath: "inset(0 0 100% 0)", duration: 1.15, ease: "expo.inOut" }).add(() => loader.remove());
    document.querySelectorAll("[data-intro-split]").forEach((el) => {
      const s = SplitText.create(el, { type: "lines,chars", mask: "lines", linesClass: "split-line" });
      tl.from(s.chars, { yPercent: 115, duration: 1.3, ease: "expo.out", stagger: 0.035 }, loader ? "-=.55" : 0);
    });
    tl.from(heroBits, { y: 30, opacity: 0, duration: 1.1, ease: "expo.out", stagger: 0.08 }, "-=1.0");
  }
  Promise.all([fonts]).then(() => {
    reveals();
    const n = loader && loader.querySelector(".n b");
    const start = performance.now();
    const minT = reduce ? 0 : 1300, maxT = 3200;
    let worldDone = false; worldReady.then(() => (worldDone = true));
    let shown = 0, done = false;
    function tick() {
      const t = performance.now() - start;
      const cap = worldDone || t > maxT ? 100 : 90;
      shown = Math.min(cap, Math.max(shown + 0.5, (t / minT) * 100));
      if (n) n.textContent = String(Math.min(99, Math.floor(shown))).padStart(2, "0");
      if (!done && shown >= 100 && t >= minT) { done = true; if (n) n.textContent = "100"; intro(); ready.forEach((f) => f()); if (hasGsap) ScrollTrigger.refresh(); return; }
      requestAnimationFrame(tick);
    }
    tick();
  });
})();
