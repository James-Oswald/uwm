import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUnifiedMapData,
  extractInlineCoordinates,
  extractLocationTemplates,
  parseWikiExportXml,
} from '../scripts/build-cache.mjs';
import { combineExportXml, computeRetryDelay, extractExportedPageXml, fetchWithRetry } from '../scripts/wiki-backup.mjs';

test('extractLocationTemplates reads direct x/y/z fields and coordinates fallback', () => {
  const wikitext = `
== Stage 1 ==
{{Location
| x = -1406
| y = 43
| z = -5073
}}

== Stage 2 ==
{{Location|coordinates=-1310, 57, -4869}}
`;

  const templates = extractLocationTemplates(wikitext);

  assert.equal(templates.length, 2);
  assert.deepEqual(
    templates.map((template) => ({ x: template.x, y: template.y, z: template.z })),
    [
      { x: -1406, y: 43, z: -5073 },
      { x: -1310, y: 57, z: -4869 },
    ],
  );
});

test('extractLocationTemplates reads RenderLocation templates too', () => {
  const wikitext = `
== Stage 1 ==
{{RenderLocation|location=Sewer Entrance|x=-1997|y=76|z=-4508}}

== Stage 2 ==
{{RenderLocation|x=-2057|y=4|z=-4498}}
`;

  const templates = extractLocationTemplates(wikitext);

  assert.equal(templates.length, 2);
  assert.deepEqual(
    templates.map((template) => ({ x: template.x, y: template.y, z: template.z })),
    [
      { x: -1997, y: 76, z: -4508 },
      { x: -2057, y: 4, z: -4498 },
    ],
  );
});

test('extractInlineCoordinates reads bracketed quest coordinates from plain text and ignores template params', () => {
  const wikitext = `
== Stage 1 ==
Talk to the scout near [123, 45, -678].
{{Location|x=1|y=2|z=3}}

== Stage 2 ==
The real destination is (321, -999).
`;

  const coordinates = extractInlineCoordinates(wikitext);

  assert.deepEqual(
    coordinates.map((coordinate) => ({ x: coordinate.x, y: coordinate.y, z: coordinate.z })),
    [
      { x: 123, y: 45, z: -678 },
      { x: 321, y: null, z: -999 },
    ],
  );
});

test('extractInlineCoordinates keeps coordinates inside spoiler template bodies', () => {
  const wikitext = `
== Stage 8 ==
{{HideSpoiler|
The hidden chamber starts at [272, 82, -329].
Then head deeper to [272, 67, -320].
}}
`;

  const coordinates = extractInlineCoordinates(wikitext);

  assert.deepEqual(
    coordinates.map((coordinate) => ({ x: coordinate.x, y: coordinate.y, z: coordinate.z })),
    [
      { x: 272, y: 82, z: -329 },
      { x: 272, y: 67, z: -320 },
    ],
  );
});

test('extractLocationTemplates reads nested RenderLocation templates inside spoiler bodies', () => {
  const wikitext = `
== Stage 2 ==
{{HideSpoiler|
{{RenderLocation|location=Sewer Entrance|x=-1997|y=76|z=-4508}}
}}
`;

  const templates = extractLocationTemplates(wikitext);

  assert.equal(templates.length, 1);
  assert.deepEqual(
    templates.map((template) => ({ x: template.x, y: template.y, z: template.z })),
    [{ x: -1997, y: 76, z: -4508 }],
  );
});

test('parseWikiExportXml reads page content and categories from a mediawiki export', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.11/" version="0.11" xml:lang="en">
  <page>
    <title>The Fortuneteller</title>
    <ns>0</ns>
    <id>1001</id>
    <revision>
      <id>2002</id>
      <text xml:space="preserve">{{Infobox/Quest|name=The Fortuneteller}}
== Stage 4 ==
The location is [630,147,-4590]
[[Category:Quests]]
[[Category:Gavel]]</text>
    </revision>
  </page>
</mediawiki>`;

  const pages = parseWikiExportXml(xml);

  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageId, 1001);
  assert.equal(pages[0].title, 'The Fortuneteller');
  assert.deepEqual(pages[0].categories, ['Category:Gavel', 'Category:Quests']);
  assert.match(pages[0].wikitext, /The location is \[630,147,-4590\]/);
});

test('extractExportedPageXml returns page blocks from a mediawiki export response', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.11/" version="0.11" xml:lang="en">
  <page><title>Page One</title><id>1</id><revision><id>11</id><text>a</text></revision></page>
  <page><title>Page Two</title><id>2</id><revision><id>22</id><text>b</text></revision></page>
</mediawiki>`;

  const pages = extractExportedPageXml(xml);

  assert.equal(pages.length, 2);
  assert.match(pages[0], /<title>Page One<\/title>/);
  assert.match(pages[1], /<title>Page Two<\/title>/);
});

test('combineExportXml builds a single export document from page chunks', () => {
  const combined = combineExportXml([
    '<page><title>Page One</title><id>1</id><revision><id>11</id><text>a</text></revision></page>',
    '<page><title>Page Two</title><id>2</id><revision><id>22</id><text>b</text></revision></page>',
  ]);

  assert.match(combined, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  assert.match(combined, /<mediawiki[^>]*>/);
  assert.match(combined, /<title>Page One<\/title>/);
  assert.match(combined, /<title>Page Two<\/title>/);
  assert.match(combined, /<\/mediawiki>\s*$/);
});

test('computeRetryDelay enforces a minimum delay for retry-after values that resolve to zero', () => {
  const response = {
    headers: {
      get(name) {
        return name.toLowerCase() === 'retry-after' ? '0' : null;
      },
    },
  };

  const delay = computeRetryDelay(response, 0);

  assert.equal(delay, 5000);
});

test('fetchWithRetry waits and succeeds after rate limiting', async () => {
  const sleepCalls = [];
  let fetchCount = 0;
  const response429 = {
    ok: false,
    status: 429,
    headers: {
      get(name) {
        return name.toLowerCase() === 'retry-after' ? '0' : null;
      },
    },
  };
  const response200 = {
    ok: true,
    status: 200,
    async text() {
      return '<mediawiki></mediawiki>';
    },
  };

  const result = await fetchWithRetry(
    'https://example.test/api',
    { headers: { Accept: 'application/xml' } },
    'https://example.test/api',
    {
      fetchImpl: async () => {
        fetchCount += 1;
        return fetchCount === 1 ? response429 : response200;
      },
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      },
      randomImpl: () => 0,
    },
  );

  assert.equal(result, response200);
  assert.equal(fetchCount, 2);
  assert.deepEqual(sleepCalls, [5000]);
});

test('buildUnifiedMapData merges official markers with wiki points on the same coordinate and creates quest paths', () => {
  const locationRaw = [
    { name: 'Darnes', icon: 'quest', x: -1406, z: -5073 },
    { name: 'Leadin Orc Fort', icon: 'marker', x: -1310, z: -4869 },
  ];

  const wikiPages = [
    {
      pageId: 874,
      title: 'A Fighting Species',
      categories: ['Category:Quests'],
      wikitext: `
{{Infobox/Quest|name=A Fighting Species}}
== Stage 1 ==
{{Location|x=-1406|y=43|z=-5073}}
== Stage 3 ==
{{Location|coordinates=-1310, 57, -4869}}
`,
    },
  ];

  const mapData = buildUnifiedMapData(locationRaw, wikiPages);

  assert.equal(mapData.points.length, 2);
  assert.equal(mapData.paths.length, 1);
  assert.equal(mapData.paths[0].kind, 'quest-path');
  assert.deepEqual(mapData.paths[0].pointIds, ['point:-1406,-5073', 'point:-1310,-4869']);

  const mergedQuestPoint = mapData.points.find((point) => point.id === 'point:-1406,-5073');
  assert.ok(mergedQuestPoint);
  assert.equal(mergedQuestPoint.name, 'Darnes');
  assert.ok(mergedQuestPoint.sourceKinds.includes('official-marker'));
  assert.ok(mergedQuestPoint.sourceKinds.includes('wiki-location-template'));
}
);

test('buildUnifiedMapData can build quest paths from RenderLocation entries', () => {
  const mapData = buildUnifiedMapData([], [
    {
      pageId: 999,
      title: 'Heart of Llevigar',
      categories: ['Category:Quests'],
      wikitext: `
{{Infobox/Quest|name=Heart of Llevigar}}
== Stage 2 ==
{{RenderLocation|location=Sewer Entrance|x=-1997|y=76|z=-4508}}
== Stage 3 ==
{{Location|location=[[Llevigar Power Plant]]|x=-2057|y=4|z=-4498}}
`,
    },
  ]);

  const questPath = mapData.paths.find((path) => path.pageTitle === 'Heart of Llevigar');
  assert.ok(questPath);
  assert.equal(questPath.kind, 'quest-path');
  assert.deepEqual(questPath.pointIds, ['point:-1997,-4508', 'point:-2057,-4498']);
});

test('buildUnifiedMapData can build quest paths from inline stage coordinates on quest pages', () => {
  const mapData = buildUnifiedMapData([], [
    {
      pageId: 1001,
      title: 'The Fortuneteller',
      categories: ['Category:Quests'],
      wikitext: `
{{Infobox/Quest|name=The Fortuneteller}}
== Stage 4 ==
The book says the location is [630,147,-4590]
== Stage 5 ==
Head up to [3916, 149, -3406].
== Trivia ==
The quest was reworked in 2.0.
`,
    },
  ]);

  const questPath = mapData.paths.find((path) => path.pageTitle === 'The Fortuneteller');
  assert.ok(questPath);
  assert.equal(questPath.kind, 'quest-path');
  assert.deepEqual(questPath.pointIds, ['point:630,-4590', 'point:3916,-3406']);

  const page = mapData.pages.find((entry) => entry.title === 'The Fortuneteller');
  assert.ok(page);
  assert.equal(page.coordinateCount, 2);
});

test('buildUnifiedMapData includes spoiler-template quest coordinates in quest paths', () => {
  const mapData = buildUnifiedMapData([], [
    {
      pageId: 1002,
      title: 'A Grave Mistake',
      categories: ['Category:Quests'],
      wikitext: `
{{Infobox/Quest|name=A Grave Mistake}}
== Stage 8 ==
{{HideSpoiler|
There are four locations in the graveyard.
* One of the locations is the church at [272, 82, -329].
* Another of the locations is the house at [288, 84, -409].
}}
`,
    },
  ]);

  const questPath = mapData.paths.find((path) => path.pageTitle === 'A Grave Mistake');
  assert.ok(questPath);
  assert.equal(questPath.kind, 'quest-path');
  assert.deepEqual(questPath.pointIds, ['point:272,-329', 'point:288,-409']);
});

test('buildUnifiedMapData skips removed quest pages', () => {
  const mapData = buildUnifiedMapData([], [
    {
      pageId: 1000,
      title: 'Thieving Rodents',
      categories: ['Category:Quests'],
      wikitext: `
{{Removed}}
{{Infobox/Quest|name=Thieving Rodents}}
== Stage 1 ==
{{Location|x=-756|y=67|z=-1661}}
== Stage 2 ==
{{Location|x=-730|y=67|z=-1650}}
`,
    },
  ]);

  assert.equal(mapData.pages.length, 0);
  assert.equal(mapData.paths.length, 0);
  assert.equal(mapData.points.length, 0);
});
