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
const LOCATION_CANDIDATES = [`${API_ORIGIN}/map/locations`, `${API_ORIGIN}/map`];

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
    locationRaw = await fetchFirstJson(LOCATION_CANDIDATES);
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
