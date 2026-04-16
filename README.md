# Unofficial Wynncraft Map (Client-Only)

A fully client-side TypeScript web app that:

- renders `TopographicMap.png` on an HTML canvas,
- supports drag-to-pan and wheel-to-zoom,
- overlays guild territories and map locations,
- reads pre-generated cached data from `cache/wynn-data.json` (no frontend API calls).

## Run locally

```bash
npm run build
npm run serve
```

Then open `http://localhost:4173`.

## Cache strategy (no backend required)

The browser only uses cached payloads:

1. Reads `cache/wynn-data.json`.
2. Reuses localStorage cache when it is newer than the bundled cache.

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
