# Unofficial Wynncraft Map (Client-Only)

A fully client-side TypeScript web app that:

- renders `TopographicMap.png` on an HTML canvas,
- supports drag-to-pan and wheel-to-zoom,
- fetches live Wynncraft data directly from the browser,
- overlays guild territories and map locations.

## Run locally

```bash
npm run build
npm run serve
```

Then open `http://localhost:4173`.

> This project has **no backend**. API calls happen directly in the browser to Wynncraft's public API.

## Notes

- Guild territory endpoint candidates are tried in order:
  - `https://api.wynncraft.com/v3/guild/list/territory`
  - `https://api.wynncraft.com/v3/guild/territory`
- Map location endpoint candidates are tried in order:
  - `https://api.wynncraft.com/v3/map/locations`
  - `https://api.wynncraft.com/v3/map`

This fallback keeps the app resilient if the API path changes between versions.
