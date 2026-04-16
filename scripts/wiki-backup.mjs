#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wikiBackupPath = resolve(repoRoot, 'cache', 'wiki-pages-backup.xml.gz');
const wikiCheckpointPath = resolve(repoRoot, 'cache', 'wiki-pages-backup-progress.json');

const WIKI_ORIGIN = 'https://wynncraft.wiki.gg';
const WIKI_API_URL = `${WIKI_ORIGIN}/api.php`;
const WIKI_LOCATION_TEMPLATE_TITLE = 'Template:Location';
const WIKI_COORDINATE_CATEGORY_TITLES = ['Category:Quests', 'Category:Mini-Quests', 'Category:Mini Quests', 'Category:Miniquests'];
const WIKI_REQUEST_DELAY_MS = 3500;
const WIKI_MAX_RETRIES = 6;
const WIKI_MIN_RETRY_DELAY_MS = 5000;
const WIKI_BACKOFF_CAP_MS = 120000;

export function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export function computeRetryDelay(response, attempt) {
  const retryAfter = response?.headers?.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(WIKI_MIN_RETRY_DELAY_MS, Math.ceil(seconds * 1000));
    }

    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) {
      return Math.max(WIKI_MIN_RETRY_DELAY_MS, retryDate - Date.now());
    }
  }

  return Math.max(WIKI_MIN_RETRY_DELAY_MS, Math.min(WIKI_BACKOFF_CAP_MS, WIKI_REQUEST_DELAY_MS * 2 ** attempt));
}

export async function fetchWithRetry(url, options, label, hooks = {}) {
  const fetchImpl = hooks.fetchImpl ?? fetch;
  const sleepImpl = hooks.sleepImpl ?? sleep;
  const randomImpl = hooks.randomImpl ?? Math.random;
  let lastError = null;

  for (let attempt = 0; attempt <= WIKI_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchImpl(url, options);
      if (response.ok) {
        return response;
      }

      if (response.status === 429 || response.status >= 500) {
        const delayMs = Math.round(computeRetryDelay(response, attempt) * (1 + randomImpl() * 0.25));
        lastError = new Error(`${label} [${response.status}]`);
        console.warn(`${label} rate-limited or unavailable, retrying in ${delayMs}ms (attempt ${attempt + 1}/${WIKI_MAX_RETRIES + 1}).`);
        await sleepImpl(delayMs);
        continue;
      }

      throw new Error(`${label} [${response.status}]`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === WIKI_MAX_RETRIES) {
        break;
      }
      const delayMs = Math.round(
        Math.max(WIKI_MIN_RETRY_DELAY_MS, Math.min(WIKI_BACKOFF_CAP_MS, WIKI_REQUEST_DELAY_MS * 2 ** attempt)) *
          (1 + randomImpl() * 0.25),
      );
      console.warn(`${label} request failed, retrying in ${delayMs}ms (attempt ${attempt + 1}/${WIKI_MAX_RETRIES + 1}).`);
      await sleepImpl(delayMs);
    }
  }

  throw lastError ?? new Error(`${label} request failed`);
}

async function fetchJson(url, params) {
  const searchParams = new URLSearchParams({
    format: 'json',
    origin: '*',
    ...params,
  });
  const response = await fetchWithRetry(`${url}?${searchParams.toString()}`, {
    headers: { Accept: 'application/json' },
  }, url);
  return await response.json();
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

async function fetchWikiEmbeddedPages() {
  const pages = [];
  let continueToken = null;

  while (true) {
    const response = await fetchJson(WIKI_API_URL, {
      action: 'query',
      list: 'embeddedin',
      eititle: WIKI_LOCATION_TEMPLATE_TITLE,
      einamespace: '0',
      eilimit: '500',
      ...(continueToken ?? {}),
    });

    const chunk = response?.query?.embeddedin ?? [];
    for (const page of chunk) {
      if (page?.ns !== 0 || !isPrimaryWikiTitle(page.title)) {
        continue;
      }
      pages.push(page.title);
    }

    if (!response.continue) {
      break;
    }

    continueToken = {
      continue: response.continue.continue,
      eicontinue: response.continue.eicontinue,
    };
  }

  return pages;
}

async function fetchWikiCategoryPages(categoryTitle) {
  const pages = [];
  let continueToken = null;

  while (true) {
    const response = await fetchJson(WIKI_API_URL, {
      action: 'query',
      list: 'categorymembers',
      cmtitle: categoryTitle,
      cmnamespace: '0',
      cmlimit: '500',
      ...(continueToken ?? {}),
    });

    const chunk = response?.query?.categorymembers ?? [];
    for (const page of chunk) {
      if (page?.ns !== 0 || !isPrimaryWikiTitle(page.title)) {
        continue;
      }
      pages.push(page.title);
    }

    if (!response.continue) {
      break;
    }

    continueToken = {
      continue: response.continue.continue,
      cmcontinue: response.continue.cmcontinue,
    };
  }

  return pages;
}

async function fetchWikiExportPage(title) {
  const searchParams = new URLSearchParams({
    action: 'query',
    export: '1',
    exportnowrap: '1',
    redirects: '1',
    titles: title,
  });

  const response = await fetchWithRetry(`${WIKI_API_URL}?${searchParams.toString()}`, {
    headers: { Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' },
  }, `${WIKI_API_URL} [${title}]`);

  return await response.text();
}

export function extractExportedPageXml(xmlChunk) {
  const matches = [...xmlChunk.matchAll(/<page>[\s\S]*?<\/page>/g)];
  return matches.map((match) => match[0]);
}

export function combineExportXml(pageChunks) {
  const sanitizedPages = pageChunks.filter((chunk) => typeof chunk === 'string' && chunk.includes('<page>'));

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.11/" version="0.11" xml:lang="en">',
    ...sanitizedPages,
    '</mediawiki>',
    '',
  ].join('\n');
}

async function loadCheckpoint() {
  try {
    const raw = await readFile(wikiCheckpointPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCheckpoint(data) {
  await mkdir(resolve(repoRoot, 'cache'), { recursive: true });
  await writeFile(wikiCheckpointPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function checkpointMatchesTitles(checkpoint, titles) {
  return (
    checkpoint &&
    Array.isArray(checkpoint.titles) &&
    checkpoint.titles.length === titles.length &&
    checkpoint.titles.every((title, index) => title === titles[index])
  );
}

export async function main() {
  const templatePages = await fetchWikiEmbeddedPages();
  const categoryPages = [];

  for (const categoryTitle of WIKI_COORDINATE_CATEGORY_TITLES) {
    try {
      categoryPages.push(...await fetchWikiCategoryPages(categoryTitle));
    } catch (error) {
      console.warn(`Could not enumerate ${categoryTitle}: ${error instanceof Error ? error.message : error}`);
    }
  }

  const titles = [...new Set([...templatePages, ...categoryPages])].sort((a, b) => a.localeCompare(b));
  const checkpoint = await loadCheckpoint();
  const progress = checkpointMatchesTitles(checkpoint, titles)
    ? {
        titles,
        nextIndex: Number.isFinite(checkpoint.nextIndex) ? checkpoint.nextIndex : 0,
        pageChunks: Array.isArray(checkpoint.pageChunks) ? checkpoint.pageChunks : [],
      }
    : {
        titles,
        nextIndex: 0,
        pageChunks: [],
      };

  for (let index = progress.nextIndex; index < titles.length; index += 1) {
    const title = titles[index];
    const xmlChunk = await fetchWikiExportPage(title);
    const pageChunks = extractExportedPageXml(xmlChunk);
    if (pageChunks.length > 0) {
      progress.pageChunks.push(...pageChunks);
    }
    progress.nextIndex = index + 1;
    await saveCheckpoint(progress);
    console.log(`Exported wiki pages ${progress.nextIndex}/${titles.length}.`);
    if (progress.nextIndex < titles.length) {
      await sleep(WIKI_REQUEST_DELAY_MS);
    }
  }

  const combinedXml = combineExportXml(progress.pageChunks);

  await mkdir(resolve(repoRoot, 'cache'), { recursive: true });
  await writeFile(wikiBackupPath, gzipSync(combinedXml));
  await rm(wikiCheckpointPath, { force: true });

  console.log(`Saved wiki XML backup to ${wikiBackupPath} with ${titles.length} page titles.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
