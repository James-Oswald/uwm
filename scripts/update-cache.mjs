#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const outputPath = resolve(repoRoot, 'cache', 'wynn-data.json');

const API_ORIGIN = 'https://api.wynncraft.com/v3';
const TERRITORY_CANDIDATES = [`${API_ORIGIN}/guild/list/territory`, `${API_ORIGIN}/guild/territory`];
const LOCATION_CANDIDATES = [`${API_ORIGIN}/map/locations/markers`, `${API_ORIGIN}/map/locations`, `${API_ORIGIN}/map`];
const LOCATION_SCRIPT_URL = 'https://map.wynncraft.com/js/labels.js';

const EMPTY_PAYLOAD = {
  updatedAt: new Date(0).toISOString(),
  territoryRaw: {},
  locationRaw: [],
};

async function fetchFirstJson(urls) {
  const failures = [];

  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) {
        failures.push(`${url} [${response.status}]`);
        continue;
      }
      return await response.json();
    } catch (error) {
      failures.push(`${url} [${error instanceof Error ? error.message : 'network-error'}]`);
    }
  }

  throw new Error(`All endpoint attempts failed: ${failures.join(', ')}`);
}

function decodeJsStringLiteral(rawLiteral) {
  try {
    return JSON.parse(rawLiteral.replace(/'/g, '"'));
  } catch {
    return rawLiteral.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function parseLocationLabelsScript(scriptText) {
  const locations = [];
  const lines = scriptText.split('\n');
  const coordsPattern = /fromWorldToLatLng\(\s*(-?\d+)\s*,\s*-?\d+\s*,\s*(-?\d+)\s*,\s*d\s*\)/;
  const htmlPattern = /html:\s*e\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/;

  for (let index = 0; index < lines.length; index += 1) {
    const coordsMatch = lines[index].match(coordsPattern);
    if (!coordsMatch) {
      continue;
    }

    const [, rawX, rawZ] = coordsMatch;

    for (let lookahead = index + 1; lookahead < Math.min(index + 4, lines.length); lookahead += 1) {
      const htmlMatch = lines[lookahead].match(htmlPattern);
      if (!htmlMatch) {
        continue;
      }

      const [, rawLabel] = htmlMatch;
      const labelHtml = decodeJsStringLiteral(rawLabel);
      const name = stripHtml(labelHtml);
      if (!name) {
        break;
      }

      locations.push({
        name,
        icon: 'marker',
        x: Number(rawX),
        z: Number(rawZ),
      });
      break;
    }
  }

  if (locations.length === 0) {
    throw new Error(`No locations could be parsed from ${LOCATION_SCRIPT_URL}`);
  }

  return {
    source: LOCATION_SCRIPT_URL,
    generatedAt: new Date().toISOString(),
    locations,
  };
}

async function fetchLocationData() {
  const failures = [];

  try {
    return await fetchFirstJson(LOCATION_CANDIDATES);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const response = await fetch(LOCATION_SCRIPT_URL, { headers: { Accept: 'text/javascript, application/javascript, text/plain' } });
    if (!response.ok) {
      failures.push(`${LOCATION_SCRIPT_URL} [${response.status}]`);
    } else {
      const scriptText = await response.text();
      return parseLocationLabelsScript(scriptText);
    }
  } catch (error) {
    failures.push(`${LOCATION_SCRIPT_URL} [${error instanceof Error ? error.message : 'network-error'}]`);
  }

  throw new Error(`All endpoint attempts failed: ${failures.join(', ')}`);
}

async function loadPreviousPayload() {
  try {
    const raw = await readFile(outputPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : EMPTY_PAYLOAD.updatedAt,
      territoryRaw: parsed.territoryRaw ?? EMPTY_PAYLOAD.territoryRaw,
      locationRaw: parsed.locationRaw ?? EMPTY_PAYLOAD.locationRaw,
    };
  } catch {
    return EMPTY_PAYLOAD;
  }
}

async function main() {
  const previous = await loadPreviousPayload();

  let territoryRaw = previous.territoryRaw;
  let locationRaw = previous.locationRaw;

  try {
    territoryRaw = await fetchFirstJson(TERRITORY_CANDIDATES);
    console.log('Fetched territories from API.');
  } catch (error) {
    console.warn(`Territory refresh failed, reusing previous cache: ${error instanceof Error ? error.message : error}`);
  }

  try {
    locationRaw = await fetchLocationData();
    console.log('Fetched locations from API.');
  } catch (error) {
    console.warn(`Location refresh failed, reusing previous cache: ${error instanceof Error ? error.message : error}`);
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    territoryRaw,
    locationRaw,
  };

  await mkdir(resolve(repoRoot, 'cache'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`Cache updated at ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
