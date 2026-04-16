import test from 'node:test';
import assert from 'node:assert/strict';

import { imageToScreen, imageToWorld, screenToImage, worldToImage, zoomAt } from '../dist/alignment.js';

const bounds = {
  minX: -2200,
  maxX: 2200,
  minZ: -5600,
  maxZ: 2200,
};

const imageWidth = 4096;
const imageHeight = 4096;

const close = (actual, expected, epsilon = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
};

test('world/image transforms are reversible for map bounds and center points', () => {
  const cases = [
    { x: bounds.minX, z: bounds.minZ },
    { x: bounds.maxX, z: bounds.maxZ },
    { x: 0, z: 0 },
    { x: 1572.25, z: -4201.5 },
  ];

  for (const point of cases) {
    const image = worldToImage(point, bounds, imageWidth, imageHeight);
    const world = imageToWorld(image, bounds, imageWidth, imageHeight);
    close(world.x, point.x);
    close(world.z, point.z);
  }
});

test('screen/image transforms are reversible at arbitrary zoom and pan', () => {
  const view = { scale: 1.85, offsetX: -283.4, offsetY: 516.9 };
  const imagePoint = { x: 1788.25, y: 900.125 };

  const screenPoint = imageToScreen(imagePoint, view);
  const backToImage = screenToImage(screenPoint, view);

  close(backToImage.x, imagePoint.x);
  close(backToImage.y, imagePoint.y);
});

test('zoomAt keeps anchor point fixed in screen-space (alignment invariant)', () => {
  const startingView = { scale: 0.75, offsetX: 120.5, offsetY: -88.25 };
  const anchor = { x: 640, y: 360 };
  const anchoredImageBeforeZoom = screenToImage(anchor, startingView);

  const nextView = zoomAt(anchor, startingView, 1.4);

  const anchoredImageAfterZoom = screenToImage(anchor, nextView);
  close(anchoredImageAfterZoom.x, anchoredImageBeforeZoom.x);
  close(anchoredImageAfterZoom.y, anchoredImageBeforeZoom.y);

  const anchorScreenAfterZoom = imageToScreen(anchoredImageBeforeZoom, nextView);
  close(anchorScreenAfterZoom.x, anchor.x);
  close(anchorScreenAfterZoom.y, anchor.y);
});

test('world stays aligned to same screen point after zoom around that point', () => {
  const worldPoint = { x: 820, z: -3120 };
  const startView = { scale: 0.9, offsetX: -40, offsetY: 100 };

  const imagePoint = worldToImage(worldPoint, bounds, imageWidth, imageHeight);
  const screenAnchor = imageToScreen(imagePoint, startView);

  const nextView = zoomAt(screenAnchor, startView, 2.2);

  const screenAfter = imageToScreen(imagePoint, nextView);
  close(screenAfter.x, screenAnchor.x);
  close(screenAfter.y, screenAnchor.y);
});
