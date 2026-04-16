import test from 'node:test';
import assert from 'node:assert/strict';

import { expandBoundsToFitData, fitBoundsToAspect, imageToScreen, imageToWorld, screenToImage, worldToImage, zoomAt } from '../dist/alignment.js';

const bounds = {
  minX: -2200,
  maxX: 2200,
  minZ: -5600,
  maxZ: 2200,
};

const imageWidth = 4096;
const imageHeight = 4096;
const imageRect = {
  left: 79,
  top: 29,
  width: 4132,
  height: 6418,
};

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

test('world/image transforms stay reversible when projecting into a content sub-rect', () => {
  const calibratedBounds = {
    minX: -2387,
    maxX: 1682,
    minZ: -6561,
    maxZ: -242,
  };
  const cases = [
    { x: calibratedBounds.minX, z: calibratedBounds.minZ },
    { x: calibratedBounds.maxX, z: calibratedBounds.maxZ },
    { x: -350, z: -3200 },
  ];

  for (const point of cases) {
    const image = worldToImage(point, calibratedBounds, 4261, 6485, imageRect);
    assert.ok(image.x >= imageRect.left && image.x <= imageRect.left + imageRect.width);
    assert.ok(image.y >= imageRect.top && image.y <= imageRect.top + imageRect.height);

    const world = imageToWorld(image, calibratedBounds, 4261, 6485, imageRect);
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


test('expandBoundsToFitData expands fallback bounds when observed data exceeds defaults', () => {
  const fallback = { minX: -2200, maxX: 2200, minZ: -5600, maxZ: 2200 };
  const points = [
    { x: -2600, z: -5800 },
    { x: 2550, z: 2450 },
  ];

  const expanded = expandBoundsToFitData(fallback, points, 10);

  assert.deepEqual(expanded, {
    minX: -2610,
    maxX: 2560,
    minZ: -5810,
    maxZ: 2460,
  });
});

test('expandBoundsToFitData keeps fallback when points are already inside', () => {
  const fallback = { minX: -2200, maxX: 2200, minZ: -5600, maxZ: 2200 };
  const points = [
    { x: -1500, z: -5300 },
    { x: 1800, z: 1400 },
  ];

  const expanded = expandBoundsToFitData(fallback, points, 10);
  assert.deepEqual(expanded, fallback);
});

test('fitBoundsToAspect expands the smaller axis to match the target image aspect ratio', () => {
  const points = [
    { x: -2291, z: -6561 },
    { x: 1586, z: -242 },
  ];

  const fitted = fitBoundsToAspect(points, imageRect.width / imageRect.height, 0);
  const width = fitted.maxX - fitted.minX;
  const height = fitted.maxZ - fitted.minZ;

  close(width / height, imageRect.width / imageRect.height, 1e-9);
  assert.ok(fitted.minX <= -2291);
  assert.ok(fitted.maxX >= 1586);
  assert.equal(fitted.minZ, -6561);
  assert.equal(fitted.maxZ, -242);
});
