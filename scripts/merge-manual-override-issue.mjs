#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(__filename, '..', '..');
const overridesPath = resolve(repoRoot, 'cache', 'manual-overrides.json');
const eventPath = process.env.GITHUB_EVENT_PATH;

const EMPTY_OVERRIDES = {
  markersToDelete: [],
  markersToAdd: [],
  questsToDelete: [],
  questsToAdd: [],
};

function canonicalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function stripCodeFence(value) {
  const trimmed = value.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function parseIssueSections(body) {
  const sections = new Map();
  const headingPattern = /^###\s+([^\n]+)\n([\s\S]*?)(?=^###\s+|\Z)/gm;

  for (const match of body.matchAll(headingPattern)) {
    sections.set(canonicalizeWhitespace(match[1]).toLowerCase(), match[2].trim());
  }

  return sections;
}

function parseJsonArray(sections, title) {
  const rawValue = sections.get(title.toLowerCase());
  if (!rawValue || rawValue === '_No response_') {
    return [];
  }

  const cleaned = stripCodeFence(rawValue);
  if (!cleaned || cleaned === '[]') {
    return [];
  }

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error(`Section "${title}" must contain a JSON array.`);
  }
  return parsed;
}

function dedupeEntries(values) {
  const seen = new Set();
  const deduped = [];

  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(value);
  }

  return deduped;
}

async function main() {
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is required.');
  }

  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const issueBody = String(event.issue?.body ?? '');
  if (!issueBody) {
    throw new Error('The approved issue does not contain a body to parse.');
  }

  const sections = parseIssueSections(issueBody);
  const overridePatch = {
    markersToDelete: parseJsonArray(sections, 'Markers to delete'),
    markersToAdd: parseJsonArray(sections, 'Markers to add'),
    questsToDelete: parseJsonArray(sections, 'Quests to delete'),
    questsToAdd: parseJsonArray(sections, 'Quests to add'),
  };

  const existing = JSON.parse(await readFile(overridesPath, 'utf8'));
  const merged = {
    markersToDelete: dedupeEntries([...(existing.markersToDelete ?? []), ...overridePatch.markersToDelete]),
    markersToAdd: dedupeEntries([...(existing.markersToAdd ?? []), ...overridePatch.markersToAdd]),
    questsToDelete: dedupeEntries([...(existing.questsToDelete ?? []), ...overridePatch.questsToDelete]),
    questsToAdd: dedupeEntries([...(existing.questsToAdd ?? []), ...overridePatch.questsToAdd]),
  };

  await writeFile(overridesPath, `${JSON.stringify({ ...EMPTY_OVERRIDES, ...merged }, null, 2)}\n`, 'utf8');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
