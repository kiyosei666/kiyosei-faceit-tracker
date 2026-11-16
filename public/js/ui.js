/* ==========================================================================
   UI behaviour only (no data, no API calls).
   - scroll-spy: highlights the nav pill / rail icon of the section in view
   - refresh button: re-runs the existing loader exposed by app.js
   To add a nav item: give a section [data-section] + id, then add a link
   with data-nav="<that id>" in index.html. Nothing to change here.
   ========================================================================== */
(() => {
  const links = [...document.querySelectorAll("[data-nav]")];
  const sections = [...document.querySelectorAll("[data-section]")];

  function setActive(id) {
    links.forEach((el) => {
      const on = el.dataset.nav === id;
      el.classList.toggle("is-active", on);
      if (on) el.setAttribute("aria-current", "true"); else el.removeAttribute("aria-current");
    });
    // keep the active pill visible in the horizontally-scrolling mobile nav
    const pill = document.querySelector(`.topnav [data-nav="${id}"]`);
    pill?.scrollIntoView({ block: "nearest", inline: "center" });
  }

  if ("IntersectionObserver" in window && sections.length) {
    const visible = new Map();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0));
      let best = null, ratio = 0;
      visible.forEach((r, id) => { if (r > ratio) { ratio = r; best = id; } });
      if (best) setActive(best);
    }, { rootMargin: "-20% 0px -45% 0px", threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    sections.forEach((s) => io.observe(s));
  }

  const refresh = document.getElementById("refresh-btn");
  refresh?.addEventListener("click", async () => {
    if (refresh.classList.contains("is-loading")) return;
    refresh.classList.add("is-loading");
    try { await window.KiyoseiApp?.refresh?.(); }
    finally { refresh.classList.remove("is-loading"); }
  });
})();
