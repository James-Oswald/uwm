# Unofficial Wynncraft Map

A fully client-side TypeScript web app that:

- renders `TopographicMap.png` from the wiki on an HTML canvas,
- supports drag-to-pan and wheel-to-zoom,
- overlays guild territories, unified map points, and quest routes,
- reads pre-generated cached data from `cache/wynn-data.json` (no frontend API calls).

## Run locally

```bash
npm run build
npm run serve
```

Then open `http://localhost:4173`.

## Cache strategy

The browser only uses cached payloads:

1. Reads `cache/wynn-data.json`.
2. Reuses localStorage cache when it is newer than the bundled cache.

The cache now stores:

- raw territory API data,
- raw official map marker data,
- raw wiki page data loaded from a local MediaWiki XML backup,
- manual override directives loaded from `overrides/manual-overrides.json`,
- a compressed wiki page backup at `cache/wiki-pages-backup.xml.gz` for offline reuse,
- a normalized `mapData` layer with deduplicated `points`, wiki `paths`, and page metadata.

## Refresh workflow

Use the scripts below in sequence:

```bash
npm run scrape:wiki
npm run build:cache
npm run serve
```

`scrape:wiki` downloads a compressed MediaWiki XML backup of the relevant wiki pages.

`build:cache` refreshes the official API data, reads the local wiki XML backup plus `overrides/manual-overrides.json`, and writes `cache/wynn-data.json`.

`update-cache` runs both steps together, and is intended for manual cache refreshes rather than normal deploys.

## Deployment behavior

The GitHub Pages deploy workflow does not scrape the wiki or rebuild cache data.
It publishes the committed `cache/wynn-data.json` and `cache/wiki-pages-backup.xml.gz` already in the repository so deploys stay fast and predictable.

If you want fresh wiki-derived data, run the manual `Refresh Cached Data` GitHub Action first or run the scripts locally and commit the updated cache files.

## Refresh cache data from Node (recommended weekly)

Use the scripts below in a manual workflow or cron to refresh the wiki backup and rebuild `cache/wynn-data.json`:

```bash
npm run scrape:wiki
npm run build:cache
```

Suggested weekly cron (UTC Sundays at 02:00):

```cron
0 2 * * 0 cd /path/to/repo && npm ci && npm run scrape:wiki && npm run build:cache
```

There is also a manual GitHub Actions workflow named `Refresh Cached Data` that runs `npm run update-cache` and commits any changed cache files back to `main`.

The build step is resilient: if one source is unavailable, it keeps the previous cached value for that section and still rebuilds the normalized `mapData` layer from whatever data is available.

## Manual overrides

Manual cache corrections live in `overrides/manual-overrides.json`.
The file supports four lists:

- `markersToDelete`: marker matchers to remove before the cache is normalized
- `markersToAdd`: marker records to inject manually
- `questsToDelete`: quest titles to remove before wiki quest parsing
- `questsToAdd`: quest records with explicit `points` to inject manually

If an override includes both a delete entry and a matching add entry, the cache build effectively treats that as a replacement.

This repository also includes two GitHub issue forms for marker and quest override requests.
After you review a request, add the `approved-override` label and the `Approve Manual Override` workflow will merge the issue payload into `overrides/manual-overrides.json` and rebuild `cache/wynn-data.json`.

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
- The wiki backup script uses the MediaWiki API to:
  - enumerate pages embedding `Template:Location`
  - enumerate quest-category pages so quest prose can be parsed even when no location template is present
  - export the selected pages as MediaWiki XML
- The cache builder then:
  - reads page wikitext from the local XML backup
  - extracts `x`, `y`, `z`, and `coordinates` values from template calls
  - extracts inline quest coordinates like `[x, y, z]` or `(x, z)` from stage text
  - builds sequential path data for quest and multi-coordinate pages

This fallback keeps the app resilient if the API path changes between versions.
