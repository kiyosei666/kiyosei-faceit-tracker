// Minimal fake of the FACEIT Data API used only for offline tests.
const http = require("http");
const PLAYER_ID = "11111111-aaaa-bbbb-cccc-000000000001";
let elo = 1700;
const mk = (n, win) => ({
  match_id: `1-test-${n}`, finished_at: 1762800000 + n * 3600, started_at: 1762799000 + n * 3600,
  results: { winner: win ? "faction1" : "faction2" },
  teams: { faction1: { roster: [{ player_id: PLAYER_ID }] }, faction2: { roster: [] } }
});
const history = Array.from({ length: 250 }, (_, i) => mk(250 - i, (250 - i) % 3 !== 0)); // newest first, like FACEIT
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== "Bearer test-key") return send(401, {});
  if (url.pathname === "/players") return send(200, { player_id: PLAYER_ID, nickname: "kiyosei", country: "ph", avatar: null, games: { cs2: { faceit_elo: elo, skill_level: 7 } } });
  if (url.pathname.endsWith("/stats/cs2")) return send(200, { lifetime: { "Win Rate %": "52", "Average K/D Ratio": "1.1", "Average Headshots %": "40" } });
  if (url.pathname.endsWith("/history")) {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
    const to = Number(url.searchParams.get("to"));
    const offset = Number(url.searchParams.get("offset")) || 0;
    let items = to ? history.filter((m) => m.started_at < to) : history;
    return send(200, { items: items.slice(to ? 0 : offset, (to ? 0 : offset) + limit) });
  }
  const m = url.pathname.match(/^\/matches\/(.+)\/stats$/);
  if (m) return send(200, { rounds: [{ round_stats: { Map: "de_mirage" }, teams: [{ team_stats: { "Final Score": "13" }, players: [{ player_id: PLAYER_ID, nickname: "kiyosei", player_stats: { "K/D Ratio": "1.2", ADR: "80", "Headshots %": "45" } }] }, { team_stats: { "Final Score": "9" }, players: [] }] }] });
  send(404, {});
});
server.listen(4010, () => console.log("mock faceit on 4010"));
