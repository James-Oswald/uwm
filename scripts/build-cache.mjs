#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const outputPath = resolve(repoRoot, 'cache', 'wynn-data.json');
const wikiBackupPath = resolve(repoRoot, 'cache', 'wiki-pages-backup.xml.gz');
const manualOverridesPath = resolve(repoRoot, 'overrides', 'manual-overrides.json');

const API_ORIGIN = 'https://api.wynncraft.com/v3';
const TERRITORY_CANDIDATES = [`${API_ORIGIN}/guild/list/territory`, `${API_ORIGIN}/guild/territory`];
const LOCATION_CANDIDATES = [`${API_ORIGIN}/map/locations/markers`, `${API_ORIGIN}/map/locations`, `${API_ORIGIN}/map`];
const LOCATION_SCRIPT_URL = 'https://map.wynncraft.com/js/labels.js';

const WIKI_ORIGIN = 'https://wynncraft.wiki.gg';

const EMPTY_PAYLOAD = {
  updatedAt: new Date(0).toISOString(),
  territoryRaw: {},
  locationRaw: [],
  wikiRaw: {
    pages: [],
  },
  mapData: {
    points: [],
    paths: [],
    pages: [],
    stats: {
      officialMarkerCount: 0,
      wikiCoordinateCount: 0,
      dedupedPointCount: 0,
      pathCount: 0,
      questPathCount: 0,
    },
  },
};

const EMPTY_MANUAL_OVERRIDES = {
  markersToDelete: [],
  markersToAdd: [],
  questsToDelete: [],
  questsToAdd: [],
};

const SUPPORTED_MANUAL_MARKER_ICONS = new Set([
  'quest',
  'location',
  'bank',
  'travel-fast',
  'travel-seaskipper',
  'housing-ballon',
  'blacksmith',
  'potion',
  'scroll-merchant',
  'merchant',
  'identifier',
  'station',
  'cave',
  'dungeon',
  'boss-altar',
  'raid',
  'misc',
]);

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

async function fetchJson(url, params) {
  const searchParams = new URLSearchParams({
    format: 'json',
    origin: '*',
    ...params,
  });
  const response = await fetch(`${url}?${searchParams.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${url} [${response.status}]`);
  }
  return await response.json();
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractCategoriesFromWikitext(wikitext) {
  const categories = new Set();
  const categoryPattern = /\[\[\s*Category\s*:\s*([^\]|]+)(?:\|[^\]]*)?\]\]/gi;

  for (const match of wikitext.matchAll(categoryPattern)) {
    const name = canonicalizeWhitespace(match[1] ?? '');
    if (!name) {
      continue;
    }
    categories.add(`Category:${name}`);
  }

  return [...categories].sort((a, b) => a.localeCompare(b));
}

export function parseWikiExportXml(xmlText) {
  const pages = [];
  const pagePattern = /<page>([\s\S]*?)<\/page>/g;

  for (const match of xmlText.matchAll(pagePattern)) {
    const pageXml = match[1];
    const titleMatch = pageXml.match(/<title>([\s\S]*?)<\/title>/);
    const idMatch = pageXml.match(/<id>(\d+)<\/id>/);
    const textMatch = pageXml.match(/<text\b[^>]*>([\s\S]*?)<\/text>/);

    const title = titleMatch ? decodeXmlEntities(titleMatch[1]) : '';
    const pageId = idMatch ? Number(idMatch[1]) : NaN;
    const wikitext = textMatch ? decodeXmlEntities(textMatch[1]) : '';

    if (!title || !Number.isFinite(pageId) || !wikitext) {
      continue;
    }

    pages.push({
      pageId,
      title,
      categories: extractCategoriesFromWikitext(wikitext),
      wikitext,
    });
  }

  return pages;
}

async function loadWikiBackup() {
  const raw = await readFile(wikiBackupPath);
  return gunzipSync(raw).toString('utf8');
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

function canonicalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeName(value) {
  return canonicalizeWhitespace(value)
    .replace(/\s+/g, ' ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function parseCoordinateParts(rawValue) {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const parts = rawValue
    .split(/[,\s/]+/)
    .map((part) => part.trim().replace(/\.$/, ''))
    .filter(Boolean)
    .map((part) => Number(part));

  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  if (parts.length >= 3) {
    return { x: parts[0], y: parts[1], z: parts[2] };
  }

  return { x: parts[0], y: null, z: parts[1] };
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tagsForManualMarkerIcon(icon) {
  switch (icon) {
    case 'quest':
      return ['manual-override', 'quest-path', 'activity'];
    case 'travel-fast':
    case 'travel-seaskipper':
      return ['manual-override', 'travel'];
    case 'bank':
    case 'potion':
    case 'scroll-merchant':
    case 'merchant':
    case 'identifier':
    case 'housing-ballon':
    case 'blacksmith':
    case 'station':
      return ['manual-override', 'service'];
    case 'cave':
    case 'dungeon':
    case 'boss-altar':
    case 'raid':
      return ['manual-override', 'hazard'];
    case 'location':
    case 'misc':
    default:
      return ['manual-override', 'location'];
  }
}

function createPointKey(x, z) {
  return `${Math.round(x)},${Math.round(z)}`;
}

function pickPrimaryAlias(aliases, preferredNames) {
  if (preferredNames.length > 0) {
    return preferredNames[0];
  }

  const sortedAliases = [...aliases.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]));
  return sortedAliases[0]?.[0] ?? 'Location';
}

function classifyPointKind(point) {
  if (point.tags.has('quest-path')) {
    return 'quest';
  }
  if (point.tags.has('travel')) {
    return 'travel';
  }
  if (point.tags.has('service')) {
    return 'service';
  }
  if (point.tags.has('hazard')) {
    return 'hazard';
  }
  return 'location';
}

function createPointRecord(existingPoint, input) {
  const point = existingPoint ?? {
    id: `point:${createPointKey(input.x, input.z)}`,
    x: Math.round(input.x),
    z: Math.round(input.z),
    y: Number.isFinite(input.y) ? Math.round(input.y) : null,
    aliases: new Map(),
    sourceKinds: new Set(),
    icons: new Set(),
    tags: new Set(),
    pages: new Set(),
    sourceRefs: [],
  };

  if (input.alias) {
    point.aliases.set(input.alias, (point.aliases.get(input.alias) ?? 0) + 1);
  }
  if (input.icon) {
    point.icons.add(input.icon);
  }
  if (input.pageTitle) {
    point.pages.add(input.pageTitle);
  }
  for (const tag of input.tags ?? []) {
    point.tags.add(tag);
  }

  point.sourceKinds.add(input.sourceKind);
  point.sourceRefs.push(input.sourceRef);
  if (!Number.isFinite(point.y) && Number.isFinite(input.y)) {
    point.y = Math.round(input.y);
  }

  return point;
}

function normalizeLocations(locationRaw) {
  const collected = [];
  const seen = new Set();

  const pushCandidate = (name, icon, x, z) => {
    const parsedX = Number(x);
    const parsedZ = Number(z);
    if (!Number.isFinite(parsedX) || !Number.isFinite(parsedZ)) {
      return;
    }
    const key = `${name}|${parsedX}|${parsedZ}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    collected.push({ name, icon, x: parsedX, z: parsedZ });
  };

  const pushFromTuple = (name, icon, tuple) => {
    if (!Array.isArray(tuple) || tuple.length < 2) {
      return;
    }
    if (tuple.length >= 3) {
      pushCandidate(name, icon, tuple[0], tuple[2]);
      return;
    }
    pushCandidate(name, icon, tuple[0], tuple[1]);
  };

  const pushFromCoordinateString = (name, icon, rawValue) => {
    const parsed = parseCoordinateParts(rawValue);
    if (!parsed) {
      return;
    }
    pushCandidate(name, icon, parsed.x, parsed.z);
  };

  const visit = (value, fallbackName) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, fallbackName);
      }
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    const obj = value;
    const name = typeof obj.name === 'string' ? obj.name : fallbackName;
    const icon = typeof obj.icon === 'string' ? obj.icon : 'marker';

    if (Array.isArray(obj.coords)) {
      pushFromTuple(name, icon, obj.coords);
    }
    if (Array.isArray(obj.coordinates)) {
      pushFromTuple(name, icon, obj.coordinates);
    }
    if ('x' in obj && 'z' in obj) {
      pushCandidate(name, icon, obj.x, obj.z);
    } else if ('x' in obj && 'y' in obj) {
      pushCandidate(name, icon, obj.x, obj.y);
    } else if ('latitude' in obj && 'longitude' in obj) {
      pushCandidate(name, icon, obj.longitude, obj.latitude);
    }

    pushFromCoordinateString(name, icon, obj.coord);
    pushFromCoordinateString(name, icon, obj.coords);
    pushFromCoordinateString(name, icon, obj.location);
    pushFromCoordinateString(name, icon, obj.position);

    if (Array.isArray(obj.location)) {
      pushFromTuple(name, icon, obj.location);
    }

    for (const [key, nested] of Object.entries(obj)) {
      if (
        key === 'name' ||
        key === 'icon' ||
        key === 'x' ||
        key === 'z' ||
        key === 'y' ||
        key === 'coords' ||
        key === 'coord' ||
        key === 'coordinates' ||
        key === 'location' ||
        key === 'position' ||
        key === 'latitude' ||
        key === 'longitude'
      ) {
        continue;
      }
      visit(nested, key);
    }
  };

  if (Array.isArray(locationRaw)) {
    visit(locationRaw, 'Location');
    return collected;
  }

  if (!locationRaw || typeof locationRaw !== 'object') {
    return [];
  }

  const rawObj = locationRaw;
  if (Array.isArray(rawObj.locations)) {
    visit(rawObj.locations, 'Location');
    return collected;
  }

  if (rawObj.locations && typeof rawObj.locations === 'object') {
    visit(rawObj.locations, 'Location');
    return collected;
  }

  visit(rawObj, 'Location');
  return collected;
}

function normalizeManualMarkerDelete(entry, index) {
  if (typeof entry === 'string') {
    const name = canonicalizeWhitespace(entry);
    if (!name) {
      throw new Error(`manual override markersToDelete[${index}] must not be an empty string`);
    }
    return { name };
  }

  if (!entry || typeof entry !== 'object') {
    throw new Error(`manual override markersToDelete[${index}] must be an object or string`);
  }

  const name = typeof entry.name === 'string' ? canonicalizeWhitespace(entry.name) : '';
  const icon = typeof entry.icon === 'string' ? canonicalizeWhitespace(entry.icon) : '';
  const x = parseOptionalNumber(entry.x);
  const z = parseOptionalNumber(entry.z ?? entry.y);

  if (!name && !icon && !Number.isFinite(x) && !Number.isFinite(z)) {
    throw new Error(`manual override markersToDelete[${index}] must include at least one matcher field`);
  }

  return {
    ...(name ? { name } : {}),
    ...(icon ? { icon } : {}),
    ...(Number.isFinite(x) ? { x } : {}),
    ...(Number.isFinite(z) ? { z } : {}),
  };
}

function normalizeManualMarkerAdd(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`manual override markersToAdd[${index}] must be an object`);
  }

  const name = canonicalizeWhitespace(String(entry.name ?? ''));
  const x = parseOptionalNumber(entry.x);
  const y = parseOptionalNumber(entry.y);
  const z = parseOptionalNumber(entry.z ?? entry.y);
  const icon = canonicalizeWhitespace(String(entry.icon ?? 'location')).toLowerCase() || 'location';

  if (!name) {
    throw new Error(`manual override markersToAdd[${index}] must include a name`);
  }
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new Error(`manual override markersToAdd[${index}] must include finite x and y coordinates`);
  }
  if (!SUPPORTED_MANUAL_MARKER_ICONS.has(icon)) {
    throw new Error(`manual override markersToAdd[${index}] icon must be one of: ${[...SUPPORTED_MANUAL_MARKER_ICONS].join(', ')}`);
  }

  return {
    name,
    icon,
    x,
    y,
    z,
    sourceKind: 'manual-marker',
    tags: Array.isArray(entry.tags)
      ? entry.tags.map((tag) => canonicalizeWhitespace(String(tag))).filter(Boolean)
      : tagsForManualMarkerIcon(icon),
  };
}

function normalizeManualQuestDelete(entry, index) {
  if (typeof entry === 'string') {
    const title = canonicalizeWhitespace(entry);
    if (!title) {
      throw new Error(`manual override questsToDelete[${index}] must not be an empty string`);
    }
    return { title };
  }

  if (!entry || typeof entry !== 'object') {
    throw new Error(`manual override questsToDelete[${index}] must be an object or string`);
  }

  const title = canonicalizeWhitespace(String(entry.title ?? ''));
  if (!title) {
    throw new Error(`manual override questsToDelete[${index}] must include a title`);
  }

  return { title };
}

function normalizeManualQuestPoint(entry, questIndex, pointIndex) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`manual override questsToAdd[${questIndex}].points[${pointIndex}] must be an object`);
  }

  const x = parseOptionalNumber(entry.x);
  const y = parseOptionalNumber(entry.y);
  const z = parseOptionalNumber(entry.z ?? entry.y);
  const label = typeof entry.label === 'string' ? canonicalizeWhitespace(entry.label) : '';

  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new Error(`manual override questsToAdd[${questIndex}].points[${pointIndex}] must include finite x and y coordinates`);
  }

  return {
    x,
    y,
    z,
    ...(label ? { label } : {}),
  };
}

function normalizeManualQuestAdd(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`manual override questsToAdd[${index}] must be an object`);
  }

  const title = canonicalizeWhitespace(String(entry.title ?? ''));
  const pageType = canonicalizeWhitespace(String(entry.pageType ?? 'quest')).toLowerCase() || 'quest';
  const categories = Array.isArray(entry.categories)
    ? entry.categories.map((category) => canonicalizeWhitespace(String(category))).filter(Boolean)
    : ['Category:Manual Overrides'];
  const points = Array.isArray(entry.points) ? entry.points.map((point, pointIndex) => normalizeManualQuestPoint(point, index, pointIndex)) : [];

  if (!title) {
    throw new Error(`manual override questsToAdd[${index}] must include a title`);
  }
  if (points.length === 0) {
    throw new Error(`manual override questsToAdd[${index}] must include at least one point`);
  }

  return {
    title,
    pageType,
    categories,
    points,
  };
}

function normalizeManualOverrides(rawOverrides) {
  if (!rawOverrides || typeof rawOverrides !== 'object') {
    return EMPTY_MANUAL_OVERRIDES;
  }

  return {
    markersToDelete: Array.isArray(rawOverrides.markersToDelete)
      ? rawOverrides.markersToDelete.map((entry, index) => normalizeManualMarkerDelete(entry, index))
      : [],
    markersToAdd: Array.isArray(rawOverrides.markersToAdd)
      ? rawOverrides.markersToAdd.map((entry, index) => normalizeManualMarkerAdd(entry, index))
      : [],
    questsToDelete: Array.isArray(rawOverrides.questsToDelete)
      ? rawOverrides.questsToDelete.map((entry, index) => normalizeManualQuestDelete(entry, index))
      : [],
    questsToAdd: Array.isArray(rawOverrides.questsToAdd)
      ? rawOverrides.questsToAdd.map((entry, index) => normalizeManualQuestAdd(entry, index))
      : [],
  };
}

async function loadManualOverrides() {
  try {
    const raw = await readFile(manualOverridesPath, 'utf8');
    return normalizeManualOverrides(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return EMPTY_MANUAL_OVERRIDES;
    }
    throw error;
  }
}

function stripComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, '');
}

function blankRanges(sourceText, ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return sourceText;
  }

  const characters = [...sourceText];
  for (const range of ranges) {
    const start = Math.max(0, range.startIndex ?? 0);
    const end = Math.min(characters.length - 1, range.endIndex ?? -1);
    for (let index = start; index <= end; index += 1) {
      if (characters[index] !== '\n') {
        characters[index] = ' ';
      }
    }
  }

  return characters.join('');
}

function readTransclusion(sourceText, startIndex) {
  if (sourceText.slice(startIndex, startIndex + 2) !== '{{') {
    return null;
  }

  let depth = 0;
  for (let index = startIndex; index < sourceText.length - 1; index += 1) {
    const pair = sourceText.slice(index, index + 2);
    if (pair === '{{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (pair === '}}') {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        return {
          startIndex,
          endIndex: index,
          text: sourceText.slice(startIndex, index + 1),
        };
      }
    }
  }

  return null;
}

function findFirstTopLevelPipeIndex(templateBody) {
  let templateDepth = 0;
  let linkDepth = 0;

  for (let index = 0; index < templateBody.length; index += 1) {
    const pair = templateBody.slice(index, index + 2);
    if (pair === '{{') {
      templateDepth += 1;
      index += 1;
      continue;
    }
    if (pair === '}}' && templateDepth > 0) {
      templateDepth -= 1;
      index += 1;
      continue;
    }
    if (pair === '[[') {
      linkDepth += 1;
      index += 1;
      continue;
    }
    if (pair === ']]' && linkDepth > 0) {
      linkDepth -= 1;
      index += 1;
      continue;
    }
    if (templateBody[index] === '|' && templateDepth === 0 && linkDepth === 0) {
      return index;
    }
  }

  return -1;
}

function getTemplateName(templateText) {
  const body = templateText.slice(2, -2).trim();
  const separatorIndex = findFirstTopLevelPipeIndex(body);
  const rawName = separatorIndex === -1 ? body : body.slice(0, separatorIndex);
  return canonicalizeWhitespace(rawName).replace(/_/g, ' ').toLowerCase();
}

function shouldPreserveInlineTemplateBody(templateName) {
  return templateName.includes('spoiler');
}

function sanitizeInlineCoordinateSegment(sourceText) {
  let result = '';

  for (let index = 0; index < sourceText.length; index += 1) {
    const pair = sourceText.slice(index, index + 2);
    if (pair !== '{{') {
      result += sourceText[index];
      continue;
    }

    const transclusion = readTransclusion(sourceText, index);
    if (!transclusion) {
      result += sourceText[index];
      continue;
    }

    const templateName = getTemplateName(transclusion.text);
    if (!shouldPreserveInlineTemplateBody(templateName)) {
      result += ' '.repeat(transclusion.text.length);
      index = transclusion.endIndex;
      continue;
    }

    const body = transclusion.text.slice(2, -2);
    const separatorIndex = findFirstTopLevelPipeIndex(body);
    if (separatorIndex === -1) {
      result += ' '.repeat(transclusion.text.length);
      index = transclusion.endIndex;
      continue;
    }

    const innerContent = body.slice(separatorIndex + 1);
    result += ' '.repeat(2 + separatorIndex + 1);
    result += sanitizeInlineCoordinateSegment(innerContent);
    result += ' '.repeat(2);
    index = transclusion.endIndex;
  }

  return result;
}

function stripInlineCoordinateNoise(sourceText) {
  const withoutComments = sourceText.replace(/<!--[\s\S]*?-->/g, (match) => ' '.repeat(match.length));
  return sanitizeInlineCoordinateSegment(withoutComments);
}

function splitTemplateParts(templateBody) {
  const parts = [];
  let current = '';
  let templateDepth = 0;
  let linkDepth = 0;

  for (let index = 0; index < templateBody.length; index += 1) {
    const pair = templateBody.slice(index, index + 2);
    if (pair === '{{') {
      templateDepth += 1;
      current += pair;
      index += 1;
      continue;
    }
    if (pair === '}}' && templateDepth > 0) {
      templateDepth -= 1;
      current += pair;
      index += 1;
      continue;
    }
    if (pair === '[[') {
      linkDepth += 1;
      current += pair;
      index += 1;
      continue;
    }
    if (pair === ']]' && linkDepth > 0) {
      linkDepth -= 1;
      current += pair;
      index += 1;
      continue;
    }
    if (templateDepth === 0 && linkDepth === 0 && templateBody[index] === '|') {
      parts.push(current);
      current = '';
      continue;
    }
    current += templateBody[index];
  }

  parts.push(current);
  return parts;
}

function parseLocationTemplateText(templateText, startIndex, ordinal) {
  const endIndex = startIndex + templateText.length - 1;
  const body = templateText.slice(2, -2).trim();
  const parts = splitTemplateParts(body);
  const templateName = canonicalizeWhitespace(parts.shift() ?? '').replace(/_/g, ' ').toLowerCase();

  if (templateName !== 'location' && templateName !== 'renderlocation') {
    return null;
  }

  const fields = {};
  for (const part of parts) {
    const equalsIndex = part.indexOf('=');
    if (equalsIndex === -1) {
      continue;
    }
    const rawKey = canonicalizeWhitespace(part.slice(0, equalsIndex)).toLowerCase();
    const rawValue = canonicalizeWhitespace(stripComments(part.slice(equalsIndex + 1)));
    fields[rawKey] = rawValue;
  }

  const coords =
    parseCoordinateParts(fields.coordinates) ??
    (() => {
      const x = Number(fields.x);
      const y = Number(fields.y);
      const z = Number(fields.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        return null;
      }
      return { x, y: Number.isFinite(y) ? y : null, z };
    })();

  if (!coords) {
    return null;
  }

  return {
    ordinal,
    startIndex,
    endIndex,
    templateText,
    fields,
    x: coords.x,
    y: coords.y,
    z: coords.z,
  };
}

export function extractLocationTemplates(sourceText) {
  const matches = [];
  for (let index = 0; index < sourceText.length; index += 1) {
    const pair = sourceText.slice(index, index + 2);
    if (pair !== '{{') {
      continue;
    }

    const transclusion = readTransclusion(sourceText, index);
    if (!transclusion) {
      continue;
    }

    const parsed = parseLocationTemplateText(transclusion.text, transclusion.startIndex, matches.length);
    if (parsed) {
      matches.push(parsed);
    }

  }

  return matches;
}

export function extractInlineCoordinates(sourceText) {
  const matches = [];
  const sanitized = stripInlineCoordinateNoise(sourceText);
  const bracketedPattern = /[\[(]\s*(-?\d{1,5})\s*,\s*(-?\d{1,4})(?:\s*,\s*(-?\d{1,5}))?\s*[\])]/g;
  const labeledPattern = /\bx\s*[:=]\s*(-?\d{1,5})\s*[,/ ]+\s*y\s*[:=]\s*(-?\d{1,4})\s*[,/ ]+\s*z\s*[:=]\s*(-?\d{1,5})\b/gi;

  for (const match of sanitized.matchAll(bracketedPattern)) {
    if (typeof match.index !== 'number') {
      continue;
    }

    const x = Number(match[1]);
    const yOrZ = Number(match[2]);
    const maybeZ = typeof match[3] === 'string' ? Number(match[3]) : null;
    if (!Number.isFinite(x) || !Number.isFinite(yOrZ)) {
      continue;
    }

    matches.push({
      startIndex: match.index,
      endIndex: match.index + match[0].length - 1,
      matchText: sourceText.slice(match.index, match.index + match[0].length),
      sourceKind: 'wiki-inline-coordinate',
      x,
      y: Number.isFinite(maybeZ) ? yOrZ : null,
      z: Number.isFinite(maybeZ) ? maybeZ : yOrZ,
    });
  }

  for (const match of sanitized.matchAll(labeledPattern)) {
    if (typeof match.index !== 'number') {
      continue;
    }

    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }

    matches.push({
      startIndex: match.index,
      endIndex: match.index + match[0].length - 1,
      matchText: sourceText.slice(match.index, match.index + match[0].length),
      sourceKind: 'wiki-inline-coordinate',
      x,
      y,
      z,
    });
  }

  matches.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
  return matches.map((match, ordinal) => ({ ...match, ordinal }));
}

function isPrimaryWikiTitle(title) {
  if (typeof title !== 'string' || !title) {
    return false;
  }

  if (/\/[a-z]{2,3}(?:-[a-z0-9]{2,8})+$/i.test(title) || /\/[a-z]{2,5}$/i.test(title)) {
    return false;
  }

  if (/\(\d+\.\d+\)$/.test(title)) {
    return false;
  }

  if (/\/archive$/i.test(title)) {
    return false;
  }

  return true;
}

function detectWikiPageType(title, wikitext) {
  const content = wikitext.toLowerCase();

  if (content.includes('{{infobox/quest')) {
    return 'quest';
  }
  if (content.includes('{{infobox/miniquest')) {
    return 'mini-quest';
  }
  if (content.includes('{{infobox/location') || content.includes('{{minorlocation')) {
    return 'location';
  }
  if (content.includes('{{infobox/dungeon')) {
    return 'dungeon';
  }
  if (content.includes('{{infobox/mob')) {
    return 'mob';
  }
  if (/\(quest\)/i.test(title)) {
    return 'quest';
  }
  return 'wiki';
}

function isRemovedWikiPage(wikitext) {
  if (typeof wikitext !== 'string') {
    return false;
  }

  return /\{\{\s*removed\b/i.test(wikitext);
}

function attachHeadingContext(wikitext, coordinateMatches) {
  const headings = [];
  const headingPattern = /^==+\s*(.+?)\s*==+\s*$/gm;
  let match;

  while ((match = headingPattern.exec(wikitext))) {
    headings.push({
      title: canonicalizeWhitespace(match[1]),
      index: match.index,
    });
  }

  return coordinateMatches
    .slice()
    .sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex)
    .map((location, ordinal) => {
      let activeHeading = '';
      for (const heading of headings) {
        if (heading.index >= location.startIndex) {
          break;
        }
        activeHeading = heading.title;
      }
      return {
        ...location,
        ordinal,
        stageLabel: activeHeading,
      };
    });
}

function tagsForOfficialMarker(location) {
  const icon = String(location.icon ?? '').toLowerCase();
  const name = String(location.name ?? '').toLowerCase();

  if (icon.includes('quest') || name.includes('quest')) {
    return ['quest-path', 'activity'];
  }
  if (icon.includes('fasttravel') || icon.includes('seaskipper') || name.includes('seaskipper')) {
    return ['travel'];
  }
  if (
    icon.includes('emerald') ||
    icon.includes('merchant') ||
    icon.includes('identifier') ||
    icon.includes('potion') ||
    icon.includes('profession') ||
    icon.includes('blacksmith') ||
    name.includes('balloon') ||
    name.includes('blacksmith') ||
    name.includes('station')
  ) {
    return ['service'];
  }
  if (icon.includes('cave') || icon.includes('dungeon') || icon.includes('raid') || icon.includes('bossaltar')) {
    return ['hazard'];
  }

  return ['location'];
}

function tagsForWikiPageType(pageType) {
  switch (pageType) {
    case 'quest':
    case 'mini-quest':
      return ['quest-path', 'activity'];
    case 'dungeon':
      return ['hazard'];
    case 'location':
      return ['location'];
    default:
      return ['wiki'];
  }
}

function matchesMarkerOverride(location, matcher) {
  if (matcher.name && normalizeName(location.name) !== normalizeName(matcher.name)) {
    return false;
  }
  if (matcher.icon && String(location.icon ?? '').toLowerCase() !== String(matcher.icon).toLowerCase()) {
    return false;
  }
  if (Number.isFinite(matcher.x) && Number(location.x) !== matcher.x) {
    return false;
  }
  if (Number.isFinite(matcher.z) && Number(location.z) !== matcher.z) {
    return false;
  }
  return true;
}

function applyMarkerOverrides(officialLocations, manualOverrides) {
  const filteredLocations = officialLocations.filter(
    (location) => !manualOverrides.markersToDelete.some((matcher) => matchesMarkerOverride(location, matcher)),
  );
  return [...filteredLocations, ...manualOverrides.markersToAdd];
}

function applyQuestOverrides(wikiPagesRaw, manualOverrides) {
  const deletedTitles = new Set(manualOverrides.questsToDelete.map((quest) => normalizeName(quest.title)));
  const keptPages = wikiPagesRaw.filter((page) => !deletedTitles.has(normalizeName(String(page?.title ?? ''))));
  const manualPages = manualOverrides.questsToAdd.map((quest, index) => ({
    pageId: -(index + 1),
    title: quest.title,
    categories: quest.categories,
    pageType: quest.pageType,
    manualPoints: quest.points,
    manualOverride: true,
    wikitext: '',
  }));

  return [...keptPages, ...manualPages];
}

export function buildUnifiedMapData(locationRaw, wikiPagesRaw, manualOverrides = EMPTY_MANUAL_OVERRIDES) {
  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  const pointMap = new Map();
  const officialLocations = applyMarkerOverrides(normalizeLocations(locationRaw), normalizedOverrides);
  const wikiPages = applyQuestOverrides(wikiPagesRaw, normalizedOverrides);

  for (const location of officialLocations) {
    const key = createPointKey(location.x, location.z);
    const sourceKind = location.sourceKind ?? 'official-marker';
    const point = createPointRecord(pointMap.get(key), {
      x: location.x,
      y: Number.isFinite(location.y) ? location.y : null,
      z: location.z,
      alias: location.name,
      icon: location.icon,
      sourceKind,
      sourceRef: {
        kind: sourceKind,
        name: location.name,
        icon: location.icon,
      },
      tags: Array.isArray(location.tags) ? location.tags : tagsForOfficialMarker(location),
    });
    pointMap.set(key, point);
  }

  const pages = [];
  const paths = [];
  let wikiCoordinateCount = 0;

  for (const rawPage of wikiPages) {
    if (!rawPage?.title || !rawPage?.wikitext) {
      if (!Array.isArray(rawPage?.manualPoints) || rawPage.manualPoints.length === 0) {
        continue;
      }
    }
    if (!isPrimaryWikiTitle(rawPage.title)) {
      continue;
    }
    if (rawPage.wikitext && isRemovedWikiPage(rawPage.wikitext)) {
      continue;
    }

    const pageType =
      typeof rawPage.pageType === 'string' && rawPage.pageType
        ? rawPage.pageType
        : detectWikiPageType(rawPage.title, rawPage.wikitext);
    const templateMatches = extractLocationTemplates(rawPage.wikitext ?? '').map((match) => ({
      ...match,
      sourceKind: 'wiki-location-template',
      matchText: match.templateText,
    }));
    const inlineMatches =
      pageType === 'quest' || pageType === 'mini-quest'
        ? extractInlineCoordinates(rawPage.wikitext ?? '')
        : [];
    const manualMatches = Array.isArray(rawPage.manualPoints)
      ? rawPage.manualPoints.map((point, ordinal) => ({
          ordinal,
          startIndex: ordinal,
          endIndex: ordinal,
          matchText: null,
          sourceKind: 'manual-quest-point',
          x: point.x,
          y: point.y,
          z: point.z,
          stageLabel: point.label || `Stage ${ordinal + 1}`,
        }))
      : [];
    const derivedCoordinates =
      manualMatches.length > 0
        ? manualMatches
        : attachHeadingContext(rawPage.wikitext ?? '', [...templateMatches, ...inlineMatches]).filter((match) => {
            if (match.sourceKind !== 'wiki-inline-coordinate') {
              return true;
            }
            return /^stage\b/i.test(match.stageLabel);
          });
    const coordinates = derivedCoordinates;

    if (coordinates.length === 0) {
      continue;
    }

    const pagePointIds = [];

    for (const coordinate of coordinates) {
      wikiCoordinateCount += 1;
      const key = createPointKey(coordinate.x, coordinate.z);
      const alias =
        pageType === 'quest' || pageType === 'mini-quest'
          ? coordinate.stageLabel
            ? `${rawPage.title} - ${coordinate.stageLabel}`
            : rawPage.title
          : rawPage.title;
      const point = createPointRecord(pointMap.get(key), {
        x: coordinate.x,
        y: coordinate.y,
        z: coordinate.z,
        alias,
        icon: pageType === 'quest' || pageType === 'mini-quest' ? 'quest' : 'marker',
        pageTitle: rawPage.title,
        sourceKind: coordinate.sourceKind,
        sourceRef: {
          kind: coordinate.sourceKind,
          pageId: rawPage.pageId,
          pageTitle: rawPage.title,
          pageType,
          stageLabel: coordinate.stageLabel || null,
          ordinal: coordinate.ordinal,
          rawText: typeof coordinate.matchText === 'string' ? coordinate.matchText : null,
        },
        tags: tagsForWikiPageType(pageType),
      });
      pointMap.set(key, point);
      pagePointIds.push(point.id);
    }

    const dedupedPagePointIds = pagePointIds.filter((pointId, index) => index === 0 || pointId !== pagePointIds[index - 1]);
    const categories = Array.isArray(rawPage.categories) ? rawPage.categories : [];

    const pageRecord = {
      id: `wiki:${rawPage.pageId}`,
      pageId: rawPage.pageId,
      title: rawPage.title,
      url: `${WIKI_ORIGIN}/wiki/${encodeURIComponent(rawPage.title.replace(/ /g, '_'))}`,
      pageType,
      categories,
      coordinateCount: coordinates.length,
      pointIds: [...new Set(pagePointIds)],
    };
    pages.push(pageRecord);

    if (dedupedPagePointIds.length >= 2) {
      const kind = pageType === 'quest' || pageType === 'mini-quest' ? 'quest-path' : 'wiki-sequence';
      paths.push({
        id: `${kind}:${rawPage.pageId}`,
        pageId: rawPage.pageId,
        pageTitle: rawPage.title,
        label: rawPage.title,
        kind,
        pointIds: dedupedPagePointIds,
      });
    }
  }

  const points = [...pointMap.values()]
    .map((point) => {
      const aliases = [...point.aliases.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]));
      const preferredNames = point.sourceRefs
        .filter(
          (source) =>
            (source.kind === 'official-marker' || source.kind === 'manual-marker') &&
            typeof source.name === 'string' &&
            normalizeName(source.name) !== 'location',
        )
        .map((source) => source.name);
      const name = pickPrimaryAlias(point.aliases, preferredNames);
      return {
        id: point.id,
        name,
        x: point.x,
        y: point.y,
        z: point.z,
        icon: point.icons.has('quest') ? 'quest' : point.icons.values().next().value ?? 'marker',
        kind: classifyPointKind(point),
        aliases: aliases.map(([alias]) => alias),
        pageTitles: [...point.pages].sort((a, b) => a.localeCompare(b)),
        sourceKinds: [...point.sourceKinds].sort((a, b) => a.localeCompare(b)),
        tags: [...point.tags].sort((a, b) => a.localeCompare(b)),
        sourceRefs: point.sourceRefs,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.x - b.x || a.z - b.z);

  return {
    points,
    paths,
    pages: pages.sort((a, b) => a.title.localeCompare(b.title)),
    stats: {
      officialMarkerCount: officialLocations.length,
      wikiCoordinateCount,
      dedupedPointCount: points.length,
      pathCount: paths.length,
      questPathCount: paths.filter((path) => path.kind === 'quest-path').length,
    },
  };
}

async function loadPreviousPayload() {
  try {
    const raw = await readFile(outputPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : EMPTY_PAYLOAD.updatedAt,
      territoryRaw: parsed.territoryRaw ?? EMPTY_PAYLOAD.territoryRaw,
      locationRaw: parsed.locationRaw ?? EMPTY_PAYLOAD.locationRaw,
      wikiRaw: parsed.wikiRaw ?? EMPTY_PAYLOAD.wikiRaw,
      mapData: parsed.mapData ?? EMPTY_PAYLOAD.mapData,
    };
  } catch {
    return EMPTY_PAYLOAD;
  }
}

export async function main() {
  const previous = await loadPreviousPayload();
  const manualOverrides = await loadManualOverrides();

  let territoryRaw = previous.territoryRaw;
  let locationRaw = previous.locationRaw;
  let wikiRaw = previous.wikiRaw;

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

  try {
    const wikiXml = await loadWikiBackup();
    const pages = parseWikiExportXml(wikiXml).filter((page) => isPrimaryWikiTitle(page.title));
    wikiRaw = {
      fetchedAt: new Date().toISOString(),
      pageCount: pages.length,
      pages,
      backupPath: wikiBackupPath,
      backupFormat: 'mediawiki-xml',
    };
    console.log(`Loaded ${pages.length} wiki pages from ${wikiBackupPath}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      console.warn(
        `Wiki backup not found at ${wikiBackupPath}. Run "npm run scrape:wiki" first, then rerun "npm run build:cache".`,
      );
    } else {
      console.warn(`Wiki backup load failed, reusing previous cache: ${message}`);
    }
  }

  const mapData = buildUnifiedMapData(locationRaw, wikiRaw.pages ?? [], manualOverrides);

  const payload = {
    updatedAt: new Date().toISOString(),
    territoryRaw,
    locationRaw,
    wikiRaw,
    manualOverrides,
    mapData,
  };

  await mkdir(resolve(repoRoot, 'cache'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(
    `Cache updated at ${outputPath} with ${mapData.stats.dedupedPointCount} points and ${mapData.stats.pathCount} paths.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
