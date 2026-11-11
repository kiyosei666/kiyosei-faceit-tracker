# Kiyosei FACEIT Tracker

A personal CS2 FACEIT comeback dashboard for tracking ELO, recent matches, lifetime statistics, and progress toward 1,800 / 1,900 / 2,000 ELO.

## Stack
- Node.js 20+ and Express
- FACEIT Data API v4
- Responsive dashboard served by the backend

## Local setup
1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Create a `.env` file in the project root with `FACEIT_API_KEY=your_key` and `FACEIT_NICKNAME=kiyosei`.
4. Run `npm start`.
5. Open http://localhost:3000.

## Environment variables
- `FACEIT_API_KEY`: required; keep it private and never commit it.
- `FACEIT_NICKNAME`: optional; defaults to `kiyosei`.
- `PORT`: optional; defaults to `3000`.

For deployment, set `FACEIT_API_KEY` as a private environment variable in your hosting provider. Never paste the key into GitHub files or chat.

## Scope
The app requests the CS2 player profile, lifetime statistics, and latest 20 matches through the server-side API. Historical ELO snapshots are not persisted yet; that requires a database or scheduled snapshot service. Confirm the live response with your own API key before relying on displayed statistics.
