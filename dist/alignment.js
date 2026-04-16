function resolveImageRect(imageWidth, imageHeight, imageRect) {
    return imageRect ?? { left: 0, top: 0, width: imageWidth, height: imageHeight };
}
export function worldToImage(point, bounds, imageWidth, imageHeight, imageRect) {
    const rect = resolveImageRect(imageWidth, imageHeight, imageRect);
    const xRatio = (point.x - bounds.minX) / (bounds.maxX - bounds.minX);
    const zRatio = (point.z - bounds.minZ) / (bounds.maxZ - bounds.minZ);
    return {
        x: rect.left + xRatio * rect.width,
        y: rect.top + zRatio * rect.height,
    };
}
export function imageToWorld(point, bounds, imageWidth, imageHeight, imageRect) {
    const rect = resolveImageRect(imageWidth, imageHeight, imageRect);
    const x = bounds.minX + ((point.x - rect.left) / rect.width) * (bounds.maxX - bounds.minX);
    const z = bounds.minZ + ((point.y - rect.top) / rect.height) * (bounds.maxZ - bounds.minZ);
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
export function fitBoundsToAspect(points, targetAspectRatio, padding = 32, fallback) {
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
        if (fallback) {
            return fallback;
        }
        return {
            minX: 0,
            maxX: 1,
            minZ: 0,
            maxZ: 1,
        };
    }
    minX -= padding;
    maxX += padding;
    minZ -= padding;
    maxZ += padding;
    let width = maxX - minX;
    let height = maxZ - minZ;
    if (width <= 0) {
        width = 1;
        minX -= 0.5;
        maxX += 0.5;
    }
    if (height <= 0) {
        height = 1;
        minZ -= 0.5;
        maxZ += 0.5;
    }
    if (Number.isFinite(targetAspectRatio) && targetAspectRatio > 0) {
        const currentAspectRatio = width / height;
        if (currentAspectRatio < targetAspectRatio) {
            const nextWidth = height * targetAspectRatio;
            const delta = (nextWidth - width) / 2;
            minX -= delta;
            maxX += delta;
        }
        else if (currentAspectRatio > targetAspectRatio) {
            const nextHeight = width / targetAspectRatio;
            const delta = (nextHeight - height) / 2;
            minZ -= delta;
            maxZ += delta;
        }
    }
    return { minX, maxX, minZ, maxZ };
}
