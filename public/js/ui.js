/* ==========================================================================
   UI behaviour only (no data, no API calls).
   - nav highlight ("scroll-spy") for the top pills and the side rail
   - refresh button, back-to-top
   To add a nav item: give a section [data-section] + id, then add a link with
   data-nav="<that id>" in index.html. Nothing to change here.

   Highlight rules
   - Section = the last one whose top has passed a reference line just under the header.
   - At the very bottom of the page the last section is active.
   - Wide layout (two columns): the spy follows the MAIN column. Side-column
     sections (FORM, COACH) are always on screen beside it, so they light up when
     you click them and stay lit until you scroll ~100px away.
   - Narrow layout (one column): every section takes part, in page order.
   ========================================================================== */
(() => {
  const links = [...document.querySelectorAll("[data-nav]")];
  const sections = [...document.querySelectorAll("[data-section]")];
  const topnav = document.querySelector(".topnav");
  const twoCol = window.matchMedia("(min-width: 1000px)");
  let active = null;
  let pinned = null;            // { id, y } – set by a nav click; y = scroll position once it settled

  function setActive(id) {
    if (!id || id === active) return;
    active = id;
    links.forEach((el) => {
      const on = el.dataset.nav === id;
      el.classList.toggle("is-active", on);
      if (on) el.setAttribute("aria-current", "true"); else el.removeAttribute("aria-current");
    });
    // keep the active pill visible in the horizontally scrolling mobile nav (never scrolls the page)
    const pill = topnav && topnav.querySelector(`[data-nav="${id}"]`);
    if (pill && topnav.scrollWidth > topnav.clientWidth) {
      topnav.scrollTo({ left: pill.offsetLeft - (topnav.clientWidth - pill.offsetWidth) / 2, behavior: "smooth" });
    }
  }

  function headerOffset() {
    const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 68;
    return h + 28;
  }

  function spyList() {
    return twoCol.matches ? sections.filter((s) => !s.closest(".layout__side")) : sections;
  }

  function update() {
    if (pinned) {
      if (pinned.y === null || Math.abs(window.scrollY - pinned.y) < 100) { setActive(pinned.id); return; }
      pinned = null;
    }
    const list = spyList();
    if (!list.length) return;
    const line = headerOffset() + Math.min(120, window.innerHeight * 0.12);
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    let current = list[0];
    if (atBottom) {
      current = list[list.length - 1];
    } else {
      let bestTop = -Infinity;
      for (const s of list) {
        const top = s.getBoundingClientRect().top;
        if (top <= line && top > bestTop) { bestTop = top; current = s; }
      }
    }
    setActive(current.id);
  }

  let ticking = false;
  const schedule = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; update(); });
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  twoCol.addEventListener?.("change", schedule);

  // Nav clicks: scroll to the section and light its pill immediately
  links.forEach((a) => a.addEventListener("click", (e) => {
    const id = a.dataset.nav;
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    pinned = { id, y: null };
    active = null;
    setActive(id);
    target.scrollIntoView({ block: "start" });         // smooth via CSS; honours reduced-motion
    if (history.replaceState) history.replaceState(null, "", `#${id}`);
    const settle = () => { if (pinned && pinned.id === id && pinned.y === null) pinned.y = window.scrollY; };
    if ("onscrollend" in window) window.addEventListener("scrollend", settle, { once: true });
    setTimeout(settle, 1100);
  }));

  document.getElementById("to-top")?.addEventListener("click", (e) => {
    e.preventDefault();
    pinned = null;
    window.scrollTo({ top: 0 });
    if (history.replaceState) history.replaceState(null, "", location.pathname + location.search);
  });

  const refresh = document.getElementById("refresh-btn");
  refresh?.addEventListener("click", async () => {
    if (refresh.classList.contains("is-loading")) return;
    refresh.classList.add("is-loading");
    try { await window.KiyoseiApp?.refresh?.(); }
    finally { refresh.classList.remove("is-loading"); }
  });

  update();
})();
