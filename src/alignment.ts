export type Vec2 = { x: number; z: number };

export type Bounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type ImagePoint = { x: number; y: number };

export type ViewState = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export function worldToImage(point: Vec2, bounds: Bounds, imageWidth: number, imageHeight: number): ImagePoint {
  const xRatio = (point.x - bounds.minX) / (bounds.maxX - bounds.minX);
  const zRatio = (point.z - bounds.minZ) / (bounds.maxZ - bounds.minZ);

  return {
    x: xRatio * imageWidth,
    y: zRatio * imageHeight,
  };
}

export function imageToWorld(point: ImagePoint, bounds: Bounds, imageWidth: number, imageHeight: number): Vec2 {
  const x = bounds.minX + (point.x / imageWidth) * (bounds.maxX - bounds.minX);
  const z = bounds.minZ + (point.y / imageHeight) * (bounds.maxZ - bounds.minZ);
  return { x, z };
}

export function imageToScreen(point: ImagePoint, view: ViewState): ImagePoint {
  return {
    x: point.x * view.scale + view.offsetX,
    y: point.y * view.scale + view.offsetY,
  };
}

export function screenToImage(point: ImagePoint, view: ViewState): ImagePoint {
  return {
    x: (point.x - view.offsetX) / view.scale,
    y: (point.y - view.offsetY) / view.scale,
  };
}

export function zoomAt(screenPoint: ImagePoint, view: ViewState, nextScale: number): ViewState {
  if (nextScale === view.scale) {
    return view;
  }

  const imagePoint = screenToImage(screenPoint, view);

  return {
    scale: nextScale,
    offsetX: screenPoint.x - imagePoint.x * nextScale,
    offsetY: screenPoint.y - imagePoint.y * nextScale,
  };
}
