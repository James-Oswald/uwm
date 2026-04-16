import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUnifiedMapData, extractLocationTemplates } from '../scripts/update-cache.mjs';

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
