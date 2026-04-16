export function worldToImage(point, bounds, imageWidth, imageHeight) {
    const xRatio = (point.x - bounds.minX) / (bounds.maxX - bounds.minX);
    const zRatio = (point.z - bounds.minZ) / (bounds.maxZ - bounds.minZ);
    return {
        x: xRatio * imageWidth,
        y: zRatio * imageHeight,
    };
}
export function imageToWorld(point, bounds, imageWidth, imageHeight) {
    const x = bounds.minX + (point.x / imageWidth) * (bounds.maxX - bounds.minX);
    const z = bounds.minZ + (point.y / imageHeight) * (bounds.maxZ - bounds.minZ);
    return { x, z };
}
export function imageToScreen(point, view) {
    return {
        x: point.x * view.scale + view.offsetX,
        y: point.y * view.scale + view.offsetY,
    };
}
export function screenToImage(point, view) {
    return {
        x: (point.x - view.offsetX) / view.scale,
        y: (point.y - view.offsetY) / view.scale,
    };
}
export function zoomAt(screenPoint, view, nextScale) {
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
export function expandBoundsToFitData(fallback, points, padding = 32) {
    if (points.length === 0) {
        return fallback;
    }
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const point of points) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) {
            continue;
        }
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
        return fallback;
    }
    return {
        minX: Math.min(fallback.minX, minX - padding),
        maxX: Math.max(fallback.maxX, maxX + padding),
        minZ: Math.min(fallback.minZ, minZ - padding),
        maxZ: Math.max(fallback.maxZ, maxZ + padding),
    };
}
