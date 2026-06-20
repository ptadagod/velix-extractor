# Velix Extractor

Server-side m3u8 extractor. Runs headless Chromium (Puppeteer) to resolve a
playable stream URL from embed providers — the same approach BrowseHere uses
natively. Because it drives a real browser engine, it captures streams inside
cross-origin iframes and grabs the exact Referer/Origin the player used.

## Why
The in-app Android WebView can only watch network requests and inject
same-origin JS, so capturing is slow and flaky. A headless browser on a server
controls the engine directly, so it resolves the m3u8 reliably and fast.

## Endpoints

```
GET /health
GET /extract?type=movie&id=550
GET /extract?type=tv&id=1399&season=1&episode=1
GET /extract?url=https://vsembed.ru/embed/550/
GET /extract?type=movie&id=550&provider=vidfast      # force one provider
```

Response:
```json
{
  "ok": true,
  "provider": "vsembed",
  "m3u8": "https://.../master.m3u8",
  "referer": "https://...",
  "origin": "https://...",
  "ms": 4200
}
```
or `{ "ok": false, "error": "no stream captured" }`.

## Deploy on Railway
1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo.
3. Railway detects `railway.json` → builds with the Dockerfile (Chromium included).
4. Add a public domain (Settings → Networking → Generate Domain).
5. Test: `https://YOUR-APP.up.railway.app/extract?type=movie&id=550`

Note: keep at least 512MB–1GB RAM; Chromium is memory-hungry. One page per
request, closed after capture.

## Local run
```
npm install
npm start
# http://localhost:8080/extract?type=movie&id=550
```

## How Velix uses it
The app calls `/extract` (e.g. on detail open or when Play is pressed), gets the
m3u8 + referer + origin, and feeds them straight into ExoPlayer — skipping the
WebView capture entirely.
