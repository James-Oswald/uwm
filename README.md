# Unofficial Wynncraft Map (Client-Only)

A fully client-side TypeScript web app that:

- renders `TopographicMap.png` on an HTML canvas,
- supports drag-to-pan and wheel-to-zoom,
- overlays guild territories and map locations,
- prefers cached data and gracefully falls back when live API requests are blocked by CORS.

## Run locally

```bash
npm run build
npm run serve
```

Then open `http://localhost:4173`.

## Cache strategy (no backend required)

Because this project is client-only, it now reads from `cache/wynn-data.json` first, then:

1. Uses localStorage cache if present.
2. Attempts a live refresh only when cache is older than 7 days (or when you click **Refresh cache**).
3. Falls back to cached data if live refresh fails (CORS/404/network).

## Refresh cache data from Node (recommended weekly)

Use the script below in CI or cron to regenerate `cache/wynn-data.json`:

```bash
npm run update-cache
```

Suggested weekly cron (UTC Sundays at 02:00):

```cron
0 2 * * 0 cd /path/to/repo && npm ci && npm run update-cache
```

The refresh script is resilient: if one endpoint is unavailable, it keeps the previous cached value for that section.

## Endpoint notes

- Guild territory endpoint candidates are tried in order:
  - `https://api.wynncraft.com/v3/guild/list/territory`
  - `https://api.wynncraft.com/v3/guild/territory`
- Map location endpoint candidates are tried in order:
  - `https://api.wynncraft.com/v3/map/locations`
  - `https://api.wynncraft.com/v3/map`

This fallback keeps the app resilient if the API path changes between versions.
