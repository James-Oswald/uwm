"use strict";
const MAP_IMAGE_URL = "./TopographicMap.png";
const API_ORIGIN = "https://api.wynncraft.com/v3";
const TERRITORY_CANDIDATES = [`${API_ORIGIN}/guild/list/territory`, `${API_ORIGIN}/guild/territory`];
const LOCATION_CANDIDATES = [`${API_ORIGIN}/map/locations`, `${API_ORIGIN}/map`];
const BUNDLED_CACHE_URL = "./cache/wynn-data.json";
const CACHE_STORAGE_KEY = "wynn-map-cached-data";
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_CACHE_PAYLOAD = {
    updatedAt: new Date(0).toISOString(),
    territoryRaw: {},
    locationRaw: [],
};
const MAP_WORLD_BOUNDS = {
    minX: -2200,
    maxX: 2200,
    minZ: -5600,
    maxZ: 2200,
};
const colorCache = new Map();
const canvas = document.querySelector("#map-canvas");
const territoriesToggle = document.querySelector("#toggle-territories");
const locationsToggle = document.querySelector("#toggle-locations");
const refreshCacheBtn = document.querySelector("#refresh-cache");
const resetBtn = document.querySelector("#reset-view");
const statusEl = document.querySelector("#status");
const ctx = canvas.getContext("2d");
const mapImage = new Image();
mapImage.decoding = "async";
mapImage.src = MAP_IMAGE_URL;
let scale = 1;
let minScale = 0.2;
let maxScale = 8;
let offsetX = 0;
let offsetY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let territories = [];
let locations = [];
let bounds = { ...MAP_WORLD_BOUNDS };
let hoveredLabel = "";
let viewportWidth = 0;
let viewportHeight = 0;
function setStatus(message) {
    statusEl.textContent = message;
}
async function fetchFirstJson(urls) {
    const failures = [];
    for (const url of urls) {
        try {
            const response = await fetch(url, {
                headers: { Accept: "application/json" },
            });
            if (!response.ok) {
                failures.push(`${url} [${response.status}]`);
                continue;
            }
            return (await response.json());
        }
        catch {
            failures.push(`${url} [network-error]`);
        }
    }
    throw new Error(`All endpoint attempts failed: ${failures.join(", ")}`);
}
async function loadBundledCache() {
    try {
        const response = await fetch(BUNDLED_CACHE_URL, { headers: { Accept: "application/json" } });
        if (!response.ok) {
            return EMPTY_CACHE_PAYLOAD;
        }
        return (await response.json());
    }
    catch {
        return EMPTY_CACHE_PAYLOAD;
    }
}
function getStoredCache() {
    try {
        const raw = localStorage.getItem(CACHE_STORAGE_KEY);
        if (!raw) {
            return null;
        }
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function setStoredCache(payload) {
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(payload));
}
function normalizeTerritories(territoryRaw) {
    if (!territoryRaw || typeof territoryRaw !== "object") {
        return {};
    }
    const rawObj = territoryRaw;
    const territoriesContainer = (typeof rawObj.territories === "object" && rawObj.territories) ||
        (typeof rawObj.results === "object" && rawObj.results) ||
        rawObj;
    const entries = Object.entries(territoriesContainer).filter(([, value]) => {
        if (!value || typeof value !== "object") {
            return false;
        }
        const location = value.location;
        return Array.isArray(location?.start) && Array.isArray(location?.end);
    });
    return Object.fromEntries(entries);
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
        if (tuple.length < 2) {
            return;
        }
        if (tuple.length >= 3) {
            pushCandidate(name, icon, tuple[0], tuple[2]);
            return;
        }
        pushCandidate(name, icon, tuple[0], tuple[1]);
    };
    const pushFromCoordinateString = (name, icon, rawValue) => {
        if (typeof rawValue !== "string") {
            return;
        }
        const parts = rawValue
            .split(/[,\s/]+/)
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => Number(part));
        if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2) {
            return;
        }
        if (parts.length >= 3) {
            pushCandidate(name, icon, parts[0], parts[2]);
            return;
        }
        pushCandidate(name, icon, parts[0], parts[1]);
    };
    const visit = (value, fallbackName) => {
        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item, fallbackName);
            }
            return;
        }
        if (!value || typeof value !== "object") {
            return;
        }
        const obj = value;
        const name = typeof obj.name === "string" ? obj.name : fallbackName;
        const icon = typeof obj.icon === "string" ? obj.icon : "marker";
        if (Array.isArray(obj.coords)) {
            pushFromTuple(name, icon, obj.coords);
        }
        if (Array.isArray(obj.coordinates)) {
            pushFromTuple(name, icon, obj.coordinates);
        }
        if ("x" in obj && "z" in obj) {
            pushCandidate(name, icon, obj.x, obj.z);
        }
        else if ("x" in obj && "y" in obj) {
            pushCandidate(name, icon, obj.x, obj.y);
        }
        else if ("latitude" in obj && "longitude" in obj) {
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
            if (key === "name" ||
                key === "icon" ||
                key === "x" ||
                key === "z" ||
                key === "y" ||
                key === "coords" ||
                key === "coord" ||
                key === "coordinates" ||
                key === "location" ||
                key === "position" ||
                key === "latitude" ||
                key === "longitude") {
                continue;
            }
            visit(nested, key);
        }
    };
    if (Array.isArray(locationRaw)) {
        visit(locationRaw, "Location");
        return collected;
    }
    if (!locationRaw || typeof locationRaw !== "object") {
        return [];
    }
    const rawObj = locationRaw;
    if (Array.isArray(rawObj.locations)) {
        visit(rawObj.locations, "Location");
        return collected;
    }
    if (rawObj.locations && typeof rawObj.locations === "object") {
        visit(rawObj.locations, "Location");
        return collected;
    }
    visit(rawObj, "Location");
    return collected;
}
function applyRawData(territoryRaw, locationRaw) {
    const normalizedTerritories = normalizeTerritories(territoryRaw);
    territories = Object.entries(normalizedTerritories).map(([name, value]) => ({
        name,
        guildName: value.guild?.name ?? "Unknown guild",
        guildPrefix: value.guild?.prefix ?? "",
        acquired: value.acquired,
        start: { x: value.location.start[0], z: value.location.start[1] },
        end: { x: value.location.end[0], z: value.location.end[1] },
    }));
    const locationsArr = normalizeLocations(locationRaw);
    locations = locationsArr
        .filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.z))
        .map((entry) => ({
        name: entry.name,
        icon: entry.icon,
        world: { x: entry.x, z: entry.z },
    }));
    updateWorldBounds();
}
function isCacheStale(updatedAt) {
    const updatedMs = Date.parse(updatedAt);
    if (!Number.isFinite(updatedMs)) {
        return true;
    }
    return Date.now() - updatedMs >= CACHE_MAX_AGE_MS;
}
function formatDateTime(isoDate) {
    const parsed = new Date(isoDate);
    if (Number.isNaN(parsed.getTime())) {
        return "unknown";
    }
    return parsed.toLocaleString();
}
function updateWorldBounds() {
    bounds = { ...MAP_WORLD_BOUNDS };
}
function worldToImage(point) {
    const xRatio = (point.x - bounds.minX) / (bounds.maxX - bounds.minX);
    const zRatio = (point.z - bounds.minZ) / (bounds.maxZ - bounds.minZ);
    return {
        x: xRatio * mapImage.width,
        y: zRatio * mapImage.height,
    };
}
function imageToScreen(point) {
    return {
        x: point.x * scale + offsetX,
        y: point.y * scale + offsetY,
    };
}
function getScaleToFitViewport() {
    if (!mapImage.width || !mapImage.height) {
        return 1;
    }
    const fitScale = Math.min(viewportWidth / mapImage.width, viewportHeight / mapImage.height);
    return Math.max(0.1, fitScale);
}
function resetView() {
    scale = getScaleToFitViewport();
    minScale = scale * 0.4;
    maxScale = scale * 10;
    offsetX = (viewportWidth - mapImage.width * scale) / 2;
    offsetY = (viewportHeight - mapImage.height * scale) / 2;
    draw();
}
function zoomAt(screenX, screenY, zoomMultiplier) {
    const nextScale = Math.max(minScale, Math.min(maxScale, scale * zoomMultiplier));
    if (nextScale === scale) {
        return;
    }
    const imageX = (screenX - offsetX) / scale;
    const imageY = (screenY - offsetY) / scale;
    scale = nextScale;
    offsetX = screenX - imageX * scale;
    offsetY = screenY - imageY * scale;
    draw();
}
function colorForGuild(prefix) {
    if (colorCache.has(prefix)) {
        return colorCache.get(prefix) ?? "#ffef65";
    }
    let hash = 0;
    for (let i = 0; i < prefix.length; i += 1) {
        hash = prefix.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    const color = `hsl(${hue}, 85%, 56%)`;
    colorCache.set(prefix, color);
    return color;
}
function drawTerritories() {
    if (!territoriesToggle.checked) {
        return;
    }
    for (const territory of territories) {
        const start = worldToImage(territory.start);
        const end = worldToImage(territory.end);
        const left = Math.min(start.x, end.x);
        const top = Math.min(start.y, end.y);
        const width = Math.abs(end.x - start.x);
        const height = Math.abs(end.y - start.y);
        const screen = imageToScreen({ x: left, y: top });
        const screenWidth = width * scale;
        const screenHeight = height * scale;
        const fill = colorForGuild(territory.guildPrefix || territory.guildName || territory.name);
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = fill;
        ctx.fillRect(screen.x, screen.y, screenWidth, screenHeight);
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = fill;
        ctx.lineWidth = Math.max(1, scale * 0.2);
        ctx.strokeRect(screen.x, screen.y, screenWidth, screenHeight);
        if (scale > minScale * 1.6 && screenWidth > 42 && screenHeight > 18) {
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#f9f9f9";
            ctx.font = `${Math.max(10, Math.min(16, scale * 1.1))}px sans-serif`;
            ctx.fillText(territory.name, screen.x + 4, screen.y + Math.max(12, Math.min(16, screenHeight - 4)));
        }
    }
    ctx.globalAlpha = 1;
}
function drawLocations() {
    if (!locationsToggle.checked) {
        return;
    }
    const radius = Math.max(2, Math.min(7, scale * 0.8));
    ctx.fillStyle = "#ffd56b";
    ctx.strokeStyle = "#101417";
    ctx.lineWidth = 1;
    for (const location of locations) {
        const image = worldToImage(location.world);
        const screen = imageToScreen(image);
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (scale > minScale * 2.1) {
            ctx.fillStyle = "#f1f5f9";
            ctx.font = `${Math.max(10, Math.min(14, scale * 0.9))}px sans-serif`;
            ctx.fillText(location.name, screen.x + radius + 3, screen.y - radius - 1);
            ctx.fillStyle = "#ffd56b";
        }
    }
}
function drawHoverLabel() {
    if (!hoveredLabel) {
        return;
    }
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(10, viewportHeight - 36, Math.min(viewportWidth - 20, 420), 26);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "13px sans-serif";
    ctx.fillText(hoveredLabel, 16, viewportHeight - 19);
}
function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!mapImage.width || !mapImage.height) {
        return;
    }
    ctx.drawImage(mapImage, offsetX, offsetY, mapImage.width * scale, mapImage.height * scale);
    drawTerritories();
    drawLocations();
    drawHoverLabel();
}
function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    viewportWidth = Math.max(1, canvas.clientWidth);
    viewportHeight = Math.max(1, canvas.clientHeight);
    canvas.width = Math.max(1, Math.floor(viewportWidth * dpr));
    canvas.height = Math.max(1, Math.floor(viewportHeight * dpr));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    resetView();
}
function screenToWorld(screenX, screenY) {
    const imageX = (screenX - offsetX) / scale;
    const imageY = (screenY - offsetY) / scale;
    const x = bounds.minX + (imageX / mapImage.width) * (bounds.maxX - bounds.minX);
    const z = bounds.minZ + (imageY / mapImage.height) * (bounds.maxZ - bounds.minZ);
    return { x, z };
}
function updateHover(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const world = screenToWorld(x, y);
    let bestDistance = Infinity;
    let bestName = "";
    if (locationsToggle.checked) {
        for (const location of locations) {
            const dx = location.world.x - world.x;
            const dz = location.world.z - world.z;
            const distance = Math.hypot(dx, dz);
            if (distance < bestDistance && distance < 55 / Math.max(scale, 0.4)) {
                bestDistance = distance;
                bestName = `${location.name} (${Math.round(location.world.x)}, ${Math.round(location.world.z)})`;
            }
        }
    }
    hoveredLabel = bestName;
    draw();
}
async function tryFetchLivePayload() {
    const [territoryRaw, locationRaw] = await Promise.all([
        fetchFirstJson(TERRITORY_CANDIDATES),
        fetchFirstJson(LOCATION_CANDIDATES),
    ]);
    return {
        updatedAt: new Date().toISOString(),
        territoryRaw,
        locationRaw,
    };
}
async function refreshCache(forceRefresh) {
    const bundledCache = await loadBundledCache();
    const storedCache = getStoredCache();
    const baseCache = storedCache ?? bundledCache;
    applyRawData(baseCache.territoryRaw, baseCache.locationRaw);
    setStatus(`Loaded ${territories.length.toLocaleString()} territories and ${locations.length.toLocaleString()} locations from cached data (${formatDateTime(baseCache.updatedAt)}).`);
    const shouldRefresh = forceRefresh || isCacheStale(baseCache.updatedAt) || locations.length === 0;
    if (!shouldRefresh) {
        return;
    }
    setStatus("Refreshing cache from Wynncraft API...");
    try {
        const freshPayload = await tryFetchLivePayload();
        setStoredCache(freshPayload);
        applyRawData(freshPayload.territoryRaw, freshPayload.locationRaw);
        setStatus(`Live refresh succeeded. Loaded ${territories.length.toLocaleString()} territories and ${locations.length.toLocaleString()} locations (${formatDateTime(freshPayload.updatedAt)}).`);
        draw();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        setStatus(`Using cached data from ${formatDateTime(baseCache.updatedAt)} (live refresh failed due to CORS/API issue: ${message}).`);
    }
}
canvas.addEventListener("pointerdown", (event) => {
    isDragging = true;
    dragStartX = event.clientX - offsetX;
    dragStartY = event.clientY - offsetY;
    canvas.classList.add("dragging");
    canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
    if (isDragging) {
        offsetX = event.clientX - dragStartX;
        offsetY = event.clientY - dragStartY;
        draw();
    }
    else {
        updateHover(event.clientX, event.clientY);
    }
});
canvas.addEventListener("pointerup", (event) => {
    isDragging = false;
    canvas.classList.remove("dragging");
    canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener("pointercancel", (event) => {
    isDragging = false;
    canvas.classList.remove("dragging");
    canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const delta = Math.sign(event.deltaY);
    const factor = delta < 0 ? 1.1 : 0.9;
    zoomAt(x, y, factor);
}, { passive: false });
territoriesToggle.addEventListener("change", draw);
locationsToggle.addEventListener("change", draw);
refreshCacheBtn.addEventListener("click", () => {
    void refreshCache(true);
});
resetBtn.addEventListener("click", resetView);
window.addEventListener("resize", resizeCanvas);
Promise.all([
    new Promise((resolve, reject) => {
        mapImage.onload = () => resolve();
        mapImage.onerror = () => reject(new Error("TopographicMap.png failed to load."));
    }),
    refreshCache(false),
])
    .then(() => {
    resizeCanvas();
})
    .catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    setStatus(`Could not load map data: ${message}`);
    resizeCanvas();
});
