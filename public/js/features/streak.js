/* Win/loss streak indicator — computed from the saved matches the dashboard already loaded.
   Matches arrive newest first. An unknown outcome ends a streak (we can't know it continued). */
(function () {
  const outcomeOf = (m) => {
    const o = String((m && m.outcome) || "").toLowerCase();
    return o === "win" || o === "loss" ? o : "unknown";
  };

  function computeStreak(matches) {
    const list = Array.isArray(matches) ? matches : [];
    const outcomes = list.map(outcomeOf);
    const first = outcomes[0];
    let length = 0;
    if (first === "win" || first === "loss") {
      while (length < outcomes.length && outcomes[length] === first) length++;
    }
    return {
      type: length ? first : null,
      length,
      last: outcomes.slice(0, 10).reverse(), // oldest -> newest for the dot strip
      sample: list.length
    };
  }

  function render(detail) {
    const pill = document.getElementById("streak-pill");
    if (!pill) return;
    const streak = computeStreak(detail && detail.matches);
    if (!streak.sample) { pill.hidden = true; return; }
    pill.hidden = false;
    pill.classList.toggle("streak--win", streak.type === "win");
    pill.classList.toggle("streak--loss", streak.type === "loss");
    const badge = document.getElementById("streak-badge");
    const text = document.getElementById("streak-text");
    const dots = document.getElementById("streak-dots");
    const word = streak.type === "win" ? "WIN" : "LOSS";
    if (badge) badge.textContent = streak.type ? (streak.type === "win" ? "W" : "L") : "–";
    if (text) {
      text.textContent = !streak.type ? "NO STREAK"
        : streak.length === 1 ? `LAST MATCH: ${word}`
        : `${streak.length} ${word} STREAK`;
    }
    if (dots) {
      dots.innerHTML = streak.last.map((o) => `<i class="${o}"></i>`).join("");
      dots.setAttribute("aria-label", `Last ${streak.last.length} results, oldest to newest`);
    }
    pill.title = streak.type
      ? `Current streak across your saved matches: ${streak.length} ${word.toLowerCase()}${streak.length === 1 ? "" : "s"}`
      : "No streak";
  }

  if (typeof document !== "undefined") document.addEventListener("kiyosei:data", (e) => render(e.detail));
  if (typeof module !== "undefined" && module.exports) module.exports = { computeStreak };
})();
