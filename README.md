# Unofficial Wynncraft Map (Client-Only)

A fully client-side TypeScript web app that:

- renders `TopographicMap.png` on an HTML canvas,
- supports drag-to-pan and wheel-to-zoom,
- overlays guild territories, unified map points, and wiki-derived route paths,
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

The cache now stores:

- raw territory API data,
- raw official map marker data,
- raw wiki page scrape results for pages that embed `Template:Location`,
- a normalized `mapData` layer with deduplicated `points`, wiki `paths`, and page metadata.

## Refresh cache data from Node (recommended weekly)

Use the script below in CI or cron to regenerate `cache/wynn-data.json`:

```bash
npm run update-cache
```

Suggested weekly cron (UTC Sundays at 02:00):

```cron
0 2 * * 0 cd /path/to/repo && npm ci && npm run update-cache
```

The refresh script is resilient: if one source is unavailable, it keeps the previous cached value for that section and still rebuilds the normalized `mapData` layer from whatever data is available.

## Endpoint notes

- Guild territory endpoint candidates are tried in order:
  - `https://api.wynncraft.com/v3/guild/list/territory`
  - `https://api.wynncraft.com/v3/guild/territory`
- Map location endpoint candidates are tried in order:
  - `https://api.wynncraft.com/v3/map/locations/markers`
  - `https://api.wynncraft.com/v3/map/locations`
  - `https://api.wynncraft.com/v3/map`
- If those API routes are unavailable, the refresh script falls back to parsing the official map labels script for named place labels only:
  - `https://map.wynncraft.com/js/labels.js`
- Wiki coordinate scraping uses the MediaWiki API to:
  - enumerate pages embedding `Template:Location`
  - fetch page wikitext and categories
  - extract `x`, `y`, `z`, and `coordinates` values from template calls
  - build sequential path data for quest and multi-coordinate pages

This fallback keeps the app resilient if the API path changes between versions.
