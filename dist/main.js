import { imageToScreen, screenToImage, zoomAt as zoomAtPoint } from "./alignment.js";
const MAP_IMAGE_URL = "./TopographicMap.png";
const BUNDLED_CACHE_URL = "./cache/wynn-data.json";
const CACHE_STORAGE_KEY = "wynn-map-cached-data";
const WIKI_ORIGIN = "https://wynncraft.wiki.gg";
const EMPTY_CACHE_PAYLOAD = {
    updatedAt: new Date(0).toISOString(),
    territoryRaw: {},
    locationRaw: [],
};
const MAP_WORLD_BOUNDS = {
    minX: -2387,
    maxX: 1682,
    minZ: -6561,
    maxZ: -242,
};
// The source PNG includes transparent padding around the actual rendered map.
// Project overlays into the opaque map content box, not the full bitmap area.
const MAP_IMAGE_CONTENT_BOX = {
    left: 79,
    top: 29,
    width: 4132,
    height: 6418,
};
// Fixed affine calibration derived from in-map anchors.
// Keeping this independent from loaded data prevents new markers from shifting the map projection.
const MAP_CALIBRATION = {
    imageXFromWorldX: 1.002643330953846,
    imageXFromWorldZ: -0.005900718062014146,
    imageXOffset: 2537.547916827523,
    imageYFromWorldX: 0.001020005851612517,
    imageYFromWorldZ: 0.9959310292885365,
    imageYOffset: 6589.284065629639,
};
const colorCache = new Map();
const canvas = document.querySelector("#map-canvas");
const territoriesToggle = document.querySelector("#toggle-territories");
const locationsToggle = document.querySelector("#toggle-locations");
const pathsToggle = document.querySelector("#toggle-paths");
const outOfBoundsMarkersToggle = document.querySelector("#toggle-out-of-bounds-markers");
const locationLabelsToggle = document.querySelector("#toggle-location-labels");
const locationIconSizeInput = document.querySelector("#location-icon-size");
const locationIconSizeValue = document.querySelector("#location-icon-size-value");
const questSelect = document.querySelector("#quest-select");
const questStageSummary = document.querySelector("#quest-stage-summary");
const questStageList = document.querySelector("#quest-stage-list");
const markerLegend = document.querySelector("#marker-legend");
const legendToggleAllBtn = document.querySelector("#legend-toggle-all");
const clearQuestSelectionBtn = document.querySelector("#clear-quest-selection");
const mobileMarkerMenuToggleBtn = document.querySelector("#mobile-marker-menu-toggle");
const mobileQuestMenuToggleBtn = document.querySelector("#mobile-quest-menu-toggle");
const mobileMenuCloseBtn = document.querySelector("#mobile-menu-close");
const mobileQuestMenuCloseBtn = document.querySelector("#mobile-quest-menu-close");
const mobileMenuBackdrop = document.querySelector("#mobile-menu-backdrop");
const sideMenu = document.querySelector("#side-menu");
const questMenu = document.querySelector("#quest-menu");
const mouseWorldCoordsEl = document.querySelector("#mouse-world-coords");
const mouseImageCoordsEl = document.querySelector("#mouse-image-coords");
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
let dragMoved = false;
let territories = [];
let markerLocations = [];
let markerPaths = [];
let questLocationById = new Map();
let questPathByKey = new Map();
let bounds = { ...MAP_WORLD_BOUNDS };
let hoveredLabel = "";
let viewportWidth = 0;
let viewportHeight = 0;
let devicePixelRatioScale = 1;
let locationIconSize = Number(locationIconSizeInput.value) || 18;
let lastPointerWorld = null;
let lastPointerImage = null;
const enabledMarkerTypes = new Set();
let hasInitializedMarkerTypes = false;
let questOptions = [];
let selectedQuestKey = "";
let hoveredQuestPointId = "";
let baseStatusMessage = "Loading map data...";
let activeOverlayMode = "marker";
let openMobileMenu = null;
let questStartsEnabled = true;
const mobileMenuMediaQuery = window.matchMedia("(max-width: 980px)");
const MARKER_TYPE_ORDER = [
    "quest",
    "location",
    "bank",
    "travel-fast",
    "travel-seaskipper",
    "travel-balloon",
    "potion",
    "scroll-merchant",
    "merchant",
    "identifier",
    "station",
    "cave",
    "dungeon",
    "boss-altar",
    "raid",
    "misc",
];
const MARKER_GROUP_ORDER = [
    "activities",
    "travel",
    "vendors",
    "services",
    "crafting",
    "hazards",
    "other",
];
const MARKER_GROUP_META = {
    activities: {
        label: "Activities",
        description: "Quest-related objectives and progression markers",
    },
    travel: {
        label: "Travel",
        description: "Fast travel, sea travel, and other transit points",
    },
    vendors: {
        label: "Vendors",
        description: "Banks, merchants, and shopping-related services",
    },
    services: {
        label: "Services",
        description: "Identifiers and other utility NPCs",
    },
    crafting: {
        label: "Crafting",
        description: "Profession stations and production areas",
    },
    hazards: {
        label: "Hazards",
        description: "Caves, dungeons, boss altars, and raids",
    },
    other: {
        label: "Other",
        description: "Everything else that does not fit a main group",
    },
};
function worldToMapImage(point) {
    return {
        x: point.x * MAP_CALIBRATION.imageXFromWorldX +
            point.z * MAP_CALIBRATION.imageXFromWorldZ +
            MAP_CALIBRATION.imageXOffset,
        y: point.x * MAP_CALIBRATION.imageYFromWorldX +
            point.z * MAP_CALIBRATION.imageYFromWorldZ +
            MAP_CALIBRATION.imageYOffset,
    };
}
function mapImageToWorld(point) {
    const a = MAP_CALIBRATION.imageXFromWorldX;
    const b = MAP_CALIBRATION.imageXFromWorldZ;
    const c = MAP_CALIBRATION.imageYFromWorldX;
    const d = MAP_CALIBRATION.imageYFromWorldZ;
    const determinant = a * d - b * c;
    const translatedX = point.x - MAP_CALIBRATION.imageXOffset;
    const translatedY = point.y - MAP_CALIBRATION.imageYOffset;
    return {
        x: (d * translatedX - b * translatedY) / determinant,
        z: (-c * translatedX + a * translatedY) / determinant,
    };
}
function updateLocationIconSizeLabel() {
    locationIconSizeValue.value = `${locationIconSize}px`;
    locationIconSizeValue.textContent = `${locationIconSize}px`;
}
function isPointWithinMapBounds(point) {
    return (point.x >= MAP_WORLD_BOUNDS.minX &&
        point.x <= MAP_WORLD_BOUNDS.maxX &&
        point.z >= MAP_WORLD_BOUNDS.minZ &&
        point.z <= MAP_WORLD_BOUNDS.maxZ);
}
function shouldShowOutOfBoundsMarkers() {
    return outOfBoundsMarkersToggle.checked;
}
function setCoordinateReadout(world, image) {
    if (!world || !image) {
        lastPointerWorld = null;
        lastPointerImage = null;
        mouseWorldCoordsEl.textContent = "x --, z --";
        mouseImageCoordsEl.textContent = "x --, y --";
        return;
    }
    lastPointerWorld = world;
    lastPointerImage = image;
    mouseWorldCoordsEl.textContent = `x ${Math.round(world.x)}, z ${Math.round(world.z)}`;
    mouseImageCoordsEl.textContent = `x ${Math.round(image.x)}, y ${Math.round(image.y)}`;
}
async function copyCurrentCoordinates() {
    if (!lastPointerWorld || !lastPointerImage) {
        setStatus("Move the mouse over the map before copying coordinates.");
        return;
    }
    const payload = `Map: x ${Math.round(lastPointerWorld.x)}, z ${Math.round(lastPointerWorld.z)}\n` +
        `Image: x ${Math.round(lastPointerImage.x)}, y ${Math.round(lastPointerImage.y)}`;
    try {
        await navigator.clipboard.writeText(payload);
        setStatus(`Copied calibration coordinates. Press "c" over the map to copy again.`);
    }
    catch {
        setStatus("Could not copy coordinates to the clipboard.");
    }
}
function classifyMarkerVisual(location) {
    const icon = location.icon.toLowerCase();
    const name = location.name.toLowerCase();
    if (location.kind === "quest") {
        return {
            key: "quest",
            label: "Quests",
            description: "Quest starts and quest-path waypoints",
            group: "activities",
            fill: "#8b5cf6",
            stroke: "#f5ebff",
            glyph: "?",
            shape: "circle",
        };
    }
    if (location.kind === "location" && icon === "marker") {
        return {
            key: "location",
            label: "Locations",
            description: "Named world locations and wiki coordinate points",
            group: "other",
            fill: "#facc15",
            stroke: "#111827",
            glyph: "•",
            shape: "circle",
        };
    }
    if (icon.includes("quest") || name.includes("quest")) {
        return {
            key: "quest",
            label: "Quests",
            description: "Quest starts and mini quests",
            group: "activities",
            fill: "#8b5cf6",
            stroke: "#f5ebff",
            glyph: "?",
            shape: "circle",
        };
    }
    if (icon.includes("emerald") || name.includes("bank") || name.includes("emerald merchant")) {
        return {
            key: "bank",
            label: "Banks",
            description: "Banks and emerald merchants",
            group: "vendors",
            fill: "#22c55e",
            stroke: "#ecfdf5",
            glyph: "◆",
            shape: "diamond",
        };
    }
    if (icon.includes("potion")) {
        return {
            key: "potion",
            label: "Potions",
            description: "Potion and liquid merchants",
            group: "vendors",
            fill: "#ef4444",
            stroke: "#fff1f2",
            glyph: "!",
            shape: "circle",
        };
    }
    if (icon.includes("fasttravel") || name === "fast travel") {
        return {
            key: "travel-fast",
            label: "Fast Travel",
            description: "Direct fast-travel points",
            group: "travel",
            fill: "#0ea5e9",
            stroke: "#eff6ff",
            glyph: "✦",
            shape: "square",
        };
    }
    if (icon.includes("seaskipper") || name.includes("seaskipper") || name.includes("sea skipper")) {
        return {
            key: "travel-seaskipper",
            label: "Sea Skipper",
            description: "Sea skipper travel routes",
            group: "travel",
            fill: "#0284c7",
            stroke: "#e0f2fe",
            glyph: "⚓",
            shape: "square",
        };
    }
    if (icon.includes("housingairballoon") || name.includes("balloon")) {
        return {
            key: "travel-balloon",
            label: "Housing Balloon",
            description: "Housing air balloon transport",
            group: "travel",
            fill: "#7dd3fc",
            stroke: "#f0f9ff",
            glyph: "◌",
            shape: "circle",
        };
    }
    if (icon.includes("merchant_scroll") ||
        icon.includes("scroll") ||
        name.includes("scroll merchant") ||
        name.includes("scrolls")) {
        return {
            key: "scroll-merchant",
            label: "Scroll Merchants",
            description: "Teleport and utility scroll vendors",
            group: "vendors",
            fill: "#c08457",
            stroke: "#fff7ed",
            glyph: "S",
            shape: "diamond",
        };
    }
    if (icon.includes("blacksmith") || icon.includes("weapon") || icon.includes("armour") || name.includes("merchant")) {
        return {
            key: "merchant",
            label: "Vendors",
            description: "Shops, buyers, and general vendors",
            group: "vendors",
            fill: "#f59e0b",
            stroke: "#fffbeb",
            glyph: "$",
            shape: "square",
        };
    }
    if (icon.includes("identifier")) {
        return {
            key: "identifier",
            label: "Identifiers",
            description: "Item identifiers and related services",
            group: "services",
            fill: "#14b8a6",
            stroke: "#f0fdfa",
            glyph: "i",
            shape: "circle",
        };
    }
    if (icon.includes("profession") || name.includes("station")) {
        return {
            key: "station",
            label: "Stations",
            description: "Profession crafting stations",
            group: "crafting",
            fill: "#06b6d4",
            stroke: "#ecfeff",
            glyph: "●",
            shape: "hex",
        };
    }
    if (icon.includes("cave") || name === "cave") {
        return {
            key: "cave",
            label: "Caves",
            description: "Caves and cave entrances",
            group: "hazards",
            fill: "#78716c",
            stroke: "#fafaf9",
            glyph: "▲",
            shape: "hex",
        };
    }
    if (icon.includes("dungeon") || name.includes("dungeon")) {
        return {
            key: "dungeon",
            label: "Dungeons",
            description: "Dungeon entrances and dungeon merchants",
            group: "hazards",
            fill: "#475569",
            stroke: "#f8fafc",
            glyph: "☠",
            shape: "hex",
        };
    }
    if (icon.includes("bossaltar") || name.includes("boss altar")) {
        return {
            key: "boss-altar",
            label: "Boss Altars",
            description: "Boss altars and altar encounters",
            group: "hazards",
            fill: "#991b1b",
            stroke: "#fee2e2",
            glyph: "✦",
            shape: "hex",
        };
    }
    if (icon.includes("raid") || icon.includes("corrupteddungeon")) {
        return {
            key: "raid",
            label: "Raids",
            description: "Raid entrances and corrupted dungeons",
            group: "hazards",
            fill: "#7f1d1d",
            stroke: "#fecaca",
            glyph: "☠",
            shape: "hex",
        };
    }
    return {
        key: "misc",
        label: "Other",
        description: "Everything else",
        group: "other",
        fill: "#facc15",
        stroke: "#111827",
        glyph: "•",
        shape: "circle",
    };
}
function drawMarkerShape(screenX, screenY, size, visual) {
    const radius = size / 2;
    ctx.beginPath();
    switch (visual.shape) {
        case "diamond":
            ctx.moveTo(screenX, screenY - radius);
            ctx.lineTo(screenX + radius, screenY);
            ctx.lineTo(screenX, screenY + radius);
            ctx.lineTo(screenX - radius, screenY);
            ctx.closePath();
            break;
        case "square":
            ctx.rect(screenX - radius, screenY - radius, size, size);
            break;
        case "hex": {
            for (let i = 0; i < 6; i += 1) {
                const angle = Math.PI / 6 + (i * Math.PI) / 3;
                const x = screenX + Math.cos(angle) * radius;
                const y = screenY + Math.sin(angle) * radius;
                if (i === 0) {
                    ctx.moveTo(x, y);
                }
                else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.closePath();
            break;
        }
        default:
            ctx.arc(screenX, screenY, Math.max(3, radius), 0, Math.PI * 2);
            break;
    }
    ctx.fillStyle = visual.fill;
    ctx.strokeStyle = visual.stroke;
    ctx.lineWidth = Math.max(1.25, size * 0.08);
    ctx.fill();
    ctx.stroke();
}
function drawMarkerGlyph(screenX, screenY, size, visual) {
    ctx.fillStyle = visual.stroke;
    ctx.font = `700 ${Math.max(8, size * 0.7)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(visual.glyph, screenX, screenY + size * 0.02);
}
function drawQuestStageMarker(screenX, screenY, size, stageNumber, isHovered) {
    const radius = size / 2;
    const badgeText = `${stageNumber}`;
    const badgeFontSize = badgeText.length >= 2 ? Math.max(8, Math.min(size * 0.56, 18)) : Math.max(8, Math.min(size * 0.72, 22));
    if (isHovered) {
        ctx.beginPath();
        ctx.arc(screenX, screenY, radius * 1.65, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(139, 92, 246, 0.18)";
        ctx.fill();
        ctx.strokeStyle = "rgba(245, 235, 255, 0.95)";
        ctx.lineWidth = Math.max(2, size * 0.12);
        ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(screenX, screenY, Math.max(5, radius), 0, Math.PI * 2);
    ctx.fillStyle = isHovered ? "#7c3aed" : "#8b5cf6";
    ctx.fill();
    ctx.strokeStyle = isHovered ? "#f5ebff" : "#ede9fe";
    ctx.lineWidth = Math.max(1.5, size * 0.11);
    ctx.stroke();
    ctx.fillStyle = "#f8fafc";
    ctx.font = `700 ${badgeFontSize}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(badgeText, screenX, screenY + size * 0.02);
}
function isMarkerTypeEnabled(typeKey) {
    return enabledMarkerTypes.has(typeKey);
}
function getSelectedQuest() {
    if (!selectedQuestKey) {
        return null;
    }
    return questOptions.find((quest) => quest.key === selectedQuestKey) ?? null;
}
function getActiveQuestLocations() {
    return getActiveQuestStageLocations().map((entry) => entry.location);
}
function getActiveQuestStageLocations() {
    const selectedQuest = getSelectedQuest();
    if (!selectedQuest) {
        return [];
    }
    return selectedQuest.pointIds
        .map((pointId, index) => {
        const location = questLocationById.get(pointId);
        if (!location) {
            return null;
        }
        if (!shouldShowOutOfBoundsMarkers() && !isPointWithinMapBounds(location.world)) {
            return null;
        }
        return { location, stageNumber: index + 1 };
    })
        .filter((entry) => Boolean(entry));
}
function getActiveQuestPath() {
    const selectedQuest = getSelectedQuest();
    if (!selectedQuest) {
        return null;
    }
    return questPathByKey.get(selectedQuest.key) ?? null;
}
function getQuestStartLocation(quest) {
    if (!quest.startPointId) {
        return null;
    }
    const location = questLocationById.get(quest.startPointId) ?? null;
    if (!location) {
        return null;
    }
    if (!shouldShowOutOfBoundsMarkers() && !isPointWithinMapBounds(location.world)) {
        return null;
    }
    return location;
}
function getVisibleQuestStarts() {
    if (!questStartsEnabled) {
        return [];
    }
    return questOptions
        .map((quest) => {
        const location = getQuestStartLocation(quest);
        return location ? { quest, location } : null;
    })
        .filter((entry) => Boolean(entry));
}
function buildQuestWikiUrl(questTitle, sectionTitle) {
    const normalizedPageTitle = questTitle.replace(/ /g, "_");
    const pageUrl = `${WIKI_ORIGIN}/wiki/${encodeURIComponent(normalizedPageTitle)}`;
    if (!sectionTitle) {
        return pageUrl;
    }
    const normalizedSectionTitle = sectionTitle.replace(/ /g, "_");
    return `${pageUrl}#${encodeURIComponent(normalizedSectionTitle)}`;
}
function getQuestStageSectionTitle(location) {
    const selectedQuest = getSelectedQuest();
    if (!selectedQuest) {
        return null;
    }
    const prefix = `${selectedQuest.label} - `;
    if (location.name.startsWith(prefix)) {
        return location.name.slice(prefix.length).trim() || null;
    }
    return location.name.trim() || null;
}
function openQuestStageWiki(location) {
    const selectedQuest = getSelectedQuest();
    if (!selectedQuest) {
        return;
    }
    const sectionTitle = getQuestStageSectionTitle(location);
    const wikiUrl = buildQuestWikiUrl(selectedQuest.label, sectionTitle ?? undefined);
    window.open(wikiUrl, "_blank", "noopener,noreferrer");
}
function getVisibleQuestPathPoints() {
    const activeQuestPath = getActiveQuestPath();
    if (!activeQuestPath) {
        return [];
    }
    return activeQuestPath.points.filter((point) => shouldShowOutOfBoundsMarkers() || isPointWithinMapBounds(point));
}
function clearQuestStageHover() {
    if (!hoveredQuestPointId) {
        return;
    }
    hoveredQuestPointId = "";
    draw();
}
function setHoveredQuestPoint(pointId) {
    if (hoveredQuestPointId === pointId) {
        return;
    }
    hoveredQuestPointId = pointId;
    draw();
}
function focusQuestOnMap() {
    const questLocations = getActiveQuestLocations();
    const questPathPoints = getVisibleQuestPathPoints();
    const pointsToFit = [...questLocations.map((location) => location.world), ...questPathPoints];
    if (pointsToFit.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) {
        return;
    }
    const imagePoints = pointsToFit.map((point) => worldToMapImage(point));
    let left = Math.min(...imagePoints.map((point) => point.x));
    let right = Math.max(...imagePoints.map((point) => point.x));
    let top = Math.min(...imagePoints.map((point) => point.y));
    let bottom = Math.max(...imagePoints.map((point) => point.y));
    if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom)) {
        return;
    }
    const minSpan = 140;
    if (right - left < minSpan) {
        const delta = (minSpan - (right - left)) / 2;
        left -= delta;
        right += delta;
    }
    if (bottom - top < minSpan) {
        const delta = (minSpan - (bottom - top)) / 2;
        top -= delta;
        bottom += delta;
    }
    const padding = Math.max(64, Math.min(viewportWidth, viewportHeight) * 0.12);
    left -= padding;
    right += padding;
    top -= padding;
    bottom += padding;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const availableWidth = Math.max(120, viewportWidth);
    const availableHeight = Math.max(120, viewportHeight);
    const nextScale = Math.max(minScale, Math.min(maxScale, Math.min(availableWidth / width, availableHeight / height)));
    scale = nextScale;
    offsetX = (viewportWidth - width * scale) / 2 - left * scale;
    offsetY = (viewportHeight - height * scale) / 2 - top * scale;
    draw();
}
function setActiveOverlayMode(nextMode) {
    if (activeOverlayMode === nextMode) {
        return;
    }
    activeOverlayMode = nextMode;
    if (nextMode !== "quest") {
        hoveredQuestPointId = "";
    }
    updateStatus();
    hoveredLabel = "";
    draw();
}
function buildLegend() {
    const counts = new Map();
    for (const location of markerLocations) {
        if (!shouldShowOutOfBoundsMarkers() && !isPointWithinMapBounds(location.world)) {
            continue;
        }
        const visual = classifyMarkerVisual(location);
        const current = counts.get(visual.key);
        if (current) {
            current.count += 1;
        }
        else {
            counts.set(visual.key, { visual, count: 1 });
        }
    }
    const visibleQuestStartCount = questOptions.reduce((count, quest) => count + (getQuestStartLocation(quest) ? 1 : 0), 0);
    if (visibleQuestStartCount > 0) {
        counts.set("quest", {
            visual: classifyMarkerVisual({
                id: "legend:quest-starts",
                name: "Quest Start",
                icon: "quest",
                kind: "quest",
                pageTitles: [],
                sourceKinds: [],
                world: { x: 0, z: 0 },
            }),
            count: visibleQuestStartCount,
        });
    }
    const entries = [...counts.values()].sort((a, b) => {
        const orderA = MARKER_TYPE_ORDER.indexOf(a.visual.key);
        const orderB = MARKER_TYPE_ORDER.indexOf(b.visual.key);
        const normalizedA = orderA === -1 ? Number.MAX_SAFE_INTEGER : orderA;
        const normalizedB = orderB === -1 ? Number.MAX_SAFE_INTEGER : orderB;
        return normalizedA - normalizedB || a.visual.label.localeCompare(b.visual.label);
    });
    if (!hasInitializedMarkerTypes) {
        for (const entry of entries) {
            if (entry.visual.key !== "quest") {
                enabledMarkerTypes.add(entry.visual.key);
            }
        }
        hasInitializedMarkerTypes = true;
    }
    const grouped = new Map();
    for (const entry of entries) {
        const groupEntries = grouped.get(entry.visual.group);
        if (groupEntries) {
            groupEntries.push(entry);
        }
        else {
            grouped.set(entry.visual.group, [entry]);
        }
    }
    markerLegend.replaceChildren();
    const orderedGroups = [...grouped.entries()].sort((a, b) => {
        const orderA = MARKER_GROUP_ORDER.indexOf(a[0]);
        const orderB = MARKER_GROUP_ORDER.indexOf(b[0]);
        const normalizedA = orderA === -1 ? Number.MAX_SAFE_INTEGER : orderA;
        const normalizedB = orderB === -1 ? Number.MAX_SAFE_INTEGER : orderB;
        return normalizedA - normalizedB;
    });
    for (const [groupKey, groupEntries] of orderedGroups) {
        const groupToggle = document.createElement("input");
        groupToggle.type = "checkbox";
        groupToggle.className = "legend-group-toggle";
        groupToggle.addEventListener("click", (event) => {
            event.stopPropagation();
        });
        const itemCheckboxes = [];
        const groupCountValue = groupEntries.reduce((sum, entry) => sum + entry.count, 0);
        const syncGroupToggle = () => {
            const checkedCount = itemCheckboxes.filter((checkbox) => checkbox.checked).length;
            groupToggle.checked = checkedCount > 0 && checkedCount === itemCheckboxes.length;
            groupToggle.indeterminate = checkedCount > 0 && checkedCount < itemCheckboxes.length;
        };
        groupToggle.addEventListener("change", () => {
            for (const checkbox of itemCheckboxes) {
                checkbox.checked = groupToggle.checked;
                const typeKey = checkbox.dataset.typeKey;
                if (!typeKey) {
                    continue;
                }
                if (typeKey === "quest") {
                    questStartsEnabled = groupToggle.checked;
                }
                else {
                    if (groupToggle.checked) {
                        enabledMarkerTypes.add(typeKey);
                    }
                    else {
                        enabledMarkerTypes.delete(typeKey);
                    }
                }
            }
            syncGroupToggle();
            draw();
        });
        const rows = groupEntries.map((entry) => {
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.dataset.typeKey = entry.visual.key;
            const isQuestStartEntry = entry.visual.key === "quest";
            checkbox.checked = isQuestStartEntry ? questStartsEnabled : enabledMarkerTypes.has(entry.visual.key);
            checkbox.addEventListener("change", () => {
                if (isQuestStartEntry) {
                    questStartsEnabled = checkbox.checked;
                }
                else {
                    if (checkbox.checked) {
                        enabledMarkerTypes.add(entry.visual.key);
                    }
                    else {
                        enabledMarkerTypes.delete(entry.visual.key);
                    }
                }
                syncGroupToggle();
                draw();
            });
            itemCheckboxes.push(checkbox);
            const symbol = createLegendSymbol(entry.visual);
            const meta = document.createElement("span");
            meta.className = "legend-meta";
            const name = document.createElement("span");
            name.className = "legend-name";
            name.textContent = entry.visual.label;
            const description = document.createElement("span");
            description.className = "legend-desc";
            description.textContent = entry.visual.description;
            meta.append(name, description);
            const count = document.createElement("span");
            count.className = "legend-count";
            count.textContent = entry.count.toLocaleString();
            const row = document.createElement("label");
            row.className = "legend-item";
            row.append(checkbox, symbol, meta, count);
            return row;
        });
        if (groupEntries.length === 1) {
            const [entry] = groupEntries;
            groupToggle.dataset.typeKey = entry.visual.key;
            const singleCard = document.createElement("div");
            singleCard.className = "legend-group legend-group-single";
            const singleRow = document.createElement("label");
            singleRow.className = "legend-group-single-row";
            const singleMeta = document.createElement("span");
            singleMeta.className = "legend-group-meta";
            const groupName = document.createElement("span");
            groupName.className = "legend-group-name";
            groupName.textContent = MARKER_GROUP_META[groupKey]?.label ?? groupKey;
            const groupDescription = document.createElement("span");
            groupDescription.className = "legend-group-desc";
            groupDescription.textContent = entry.visual.label;
            singleMeta.append(groupName, groupDescription);
            const singleCount = document.createElement("span");
            singleCount.className = "legend-group-count";
            singleCount.textContent = groupCountValue.toLocaleString();
            singleRow.append(groupToggle, createLegendSymbol(entry.visual), singleMeta, singleCount);
            singleCard.append(singleRow);
            markerLegend.append(singleCard);
            syncGroupToggle();
            continue;
        }
        const details = document.createElement("details");
        details.className = "legend-group";
        details.open = false;
        const summary = document.createElement("summary");
        summary.className = "legend-group-summary";
        const groupPreview = createLegendGroupPreview(groupEntries);
        const groupMeta = document.createElement("span");
        groupMeta.className = "legend-group-meta";
        const groupName = document.createElement("span");
        groupName.className = "legend-group-name";
        groupName.textContent = MARKER_GROUP_META[groupKey]?.label ?? groupKey;
        const groupDescription = document.createElement("span");
        groupDescription.className = "legend-group-desc";
        groupDescription.textContent = MARKER_GROUP_META[groupKey]?.description ?? "";
        groupMeta.append(groupName, groupDescription);
        const groupCount = document.createElement("span");
        groupCount.className = "legend-group-count";
        groupCount.textContent = groupCountValue.toLocaleString();
        const groupList = document.createElement("div");
        groupList.className = "legend-group-list";
        summary.append(groupToggle, groupPreview, groupMeta, groupCount);
        details.append(summary);
        groupList.append(...rows);
        syncGroupToggle();
        details.append(groupList);
        markerLegend.append(details);
    }
}
function createLegendSymbol(visual, extraClassName = "") {
    const symbol = document.createElement("span");
    symbol.className = `legend-symbol shape-${visual.shape}${extraClassName ? ` ${extraClassName}` : ""}`;
    symbol.style.background = visual.fill;
    symbol.style.border = `2px solid ${visual.stroke}`;
    symbol.style.color = visual.stroke;
    const symbolText = document.createElement("span");
    symbolText.textContent = visual.glyph;
    symbol.append(symbolText);
    return symbol;
}
function createLegendGroupPreview(groupEntries) {
    const preview = document.createElement("span");
    preview.className = `legend-group-preview count-${groupEntries.length}`;
    preview.setAttribute("aria-hidden", "true");
    groupEntries.slice(0, 4).forEach((entry, index) => {
        const previewItem = createLegendSymbol(entry.visual, `legend-group-preview-item preview-index-${index}`);
        preview.append(previewItem);
    });
    return preview;
}
function setStatus(message) {
    statusEl.textContent = message;
}
function updateStatus() {
    const questMessage = activeOverlayMode === "quest"
        ? selectedQuestKey
            ? ` Quest mode is active for ${selectedQuestKey}.`
            : questOptions.length > 0
                ? " Quest mode is ready. Select a quest from the right menu to load its markers."
                : ""
        : selectedQuestKey
            ? ` Marker mode is active. Quest markers for ${selectedQuestKey} are hidden until you use the quest menu again.`
            : "";
    setStatus(`${baseStatusMessage}${questMessage}`);
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
    try {
        localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(payload));
        return null;
    }
    catch (error) {
        if (error instanceof Error) {
            return error.message;
        }
        return "Unknown cache storage error";
    }
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
function normalizeMapData(mapData) {
    if (!mapData || typeof mapData !== "object") {
        return null;
    }
    const raw = mapData;
    if (!Array.isArray(raw.points) || !Array.isArray(raw.paths)) {
        return null;
    }
    return raw;
}
function buildQuestOptions(normalizedMapData) {
    if (!normalizedMapData?.pages?.length) {
        return [];
    }
    const questPathByTitle = new Map(normalizedMapData.paths
        .filter((path) => path.kind === "quest-path" && typeof path.pageTitle === "string")
        .map((path) => [path.pageTitle, path]));
    return normalizedMapData.pages
        .filter((page) => page.pageType === "quest" || page.pageType === "mini-quest")
        .map((page) => {
        const path = questPathByTitle.get(page.title);
        const pointIds = Array.isArray(path?.pointIds) && path.pointIds.length > 0 ? path.pointIds : Array.isArray(page.pointIds) ? page.pointIds : [];
        return {
            key: page.title,
            label: page.title,
            pageType: page.pageType,
            pointIds,
            startPointId: pointIds[0] ?? null,
            pathId: path?.id ?? null,
        };
    })
        .filter((quest) => quest.startPointId)
        .sort((a, b) => a.label.localeCompare(b.label));
}
function syncQuestSelectionControl() {
    const validQuestKeys = new Set(questOptions.map((quest) => quest.key));
    if (selectedQuestKey && !validQuestKeys.has(selectedQuestKey)) {
        selectedQuestKey = "";
        hoveredQuestPointId = "";
    }
    questSelect.replaceChildren();
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Select a quest";
    questSelect.append(defaultOption);
    for (const quest of questOptions) {
        const option = document.createElement("option");
        option.value = quest.key;
        option.textContent = quest.label;
        questSelect.append(option);
    }
    questSelect.value = selectedQuestKey;
}
function buildQuestStageList() {
    const selectedQuest = getSelectedQuest();
    const activeQuestStages = getActiveQuestStageLocations();
    questStageList.replaceChildren();
    if (!selectedQuest || activeQuestStages.length === 0) {
        questStageSummary.textContent = selectedQuest
            ? "This quest does not currently have ordered stage markers to show."
            : "Select a quest to view its stages.";
        return;
    }
    questStageSummary.textContent = `${selectedQuest.label} has ${activeQuestStages.length.toLocaleString()} numbered stages. Hover a stage to highlight it on the map.`;
    activeQuestStages.forEach(({ location, stageNumber }) => {
        const item = document.createElement("li");
        item.className = "quest-stage-item";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quest-stage-button";
        button.dataset.pointId = location.id;
        const indexBadge = document.createElement("span");
        indexBadge.className = "quest-stage-index";
        indexBadge.textContent = `${stageNumber}`;
        const meta = document.createElement("span");
        meta.className = "quest-stage-meta";
        const name = document.createElement("span");
        name.className = "quest-stage-name";
        name.textContent = location.name;
        const coords = document.createElement("span");
        coords.className = "quest-stage-coords";
        coords.textContent = `x ${Math.round(location.world.x)}, z ${Math.round(location.world.z)}`;
        meta.append(name, coords);
        button.append(indexBadge, meta);
        const syncHoverState = (isHovered) => {
            button.classList.toggle("is-hovered", isHovered);
        };
        button.addEventListener("pointerenter", () => {
            setHoveredQuestPoint(location.id);
            syncHoverState(true);
        });
        button.addEventListener("pointerleave", () => {
            clearQuestStageHover();
            syncHoverState(false);
        });
        button.addEventListener("focus", () => {
            setHoveredQuestPoint(location.id);
            syncHoverState(true);
        });
        button.addEventListener("blur", () => {
            clearQuestStageHover();
            syncHoverState(false);
        });
        button.addEventListener("click", () => {
            setActiveOverlayMode("quest");
            setHoveredQuestPoint(location.id);
            openQuestStageWiki(location);
        });
        item.append(button);
        questStageList.append(item);
    });
}
function revealQuestStartInLeftMenu(questKey) {
    questStartsEnabled = true;
    buildLegend();
    setActiveOverlayMode("marker");
    setMobileMenuOpen("markers");
}
function activateQuestFromStart(questKey) {
    selectedQuestKey = questKey;
    questSelect.value = questKey;
    hoveredQuestPointId = "";
    buildQuestStageList();
    setActiveOverlayMode("quest");
    focusQuestOnMap();
    setMobileMenuOpen("quests");
}
function shouldRenderLocation(location) {
    if (activeOverlayMode !== "marker") {
        return false;
    }
    if (!shouldShowOutOfBoundsMarkers() && !isPointWithinMapBounds(location.world)) {
        return false;
    }
    return true;
}
function shouldRenderPath(path) {
    return activeOverlayMode === "marker" && path.kind !== "quest-path";
}
function applyRawData(territoryRaw, locationRaw, mapData) {
    const normalizedTerritories = normalizeTerritories(territoryRaw);
    territories = Object.entries(normalizedTerritories).map(([name, value]) => ({
        name,
        guildName: value.guild?.name ?? "Unknown guild",
        guildPrefix: value.guild?.prefix ?? "",
        acquired: value.acquired,
        start: { x: value.location.start[0], z: value.location.start[1] },
        end: { x: value.location.end[0], z: value.location.end[1] },
    }));
    const normalizedMapData = normalizeMapData(mapData);
    if (normalizedMapData) {
        const pointById = new Map();
        const allPoints = normalizedMapData.points
            .filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.z))
            .map((entry) => {
            const point = {
                id: entry.id,
                name: entry.name,
                icon: entry.icon,
                kind: entry.kind,
                pageTitles: Array.isArray(entry.pageTitles) ? entry.pageTitles : [],
                sourceKinds: Array.isArray(entry.sourceKinds) ? entry.sourceKinds : [],
                world: { x: entry.x, z: entry.z },
            };
            pointById.set(point.id, point);
            return point;
        });
        const allPaths = normalizedMapData.paths
            .map((path) => ({
            id: path.id,
            label: path.label,
            kind: path.kind,
            pageTitle: path.pageTitle,
            points: path.pointIds
                .map((pointId) => pointById.get(pointId)?.world)
                .filter((point) => Boolean(point)),
        }))
            .filter((path) => path.points.length >= 2);
        questOptions = buildQuestOptions(normalizedMapData);
        const questPointIds = new Set(questOptions.flatMap((quest) => quest.pointIds));
        markerLocations = allPoints.filter((point) => !questPointIds.has(point.id) && point.kind !== "quest");
        questLocationById = new Map(allPoints.filter((point) => questPointIds.has(point.id)).map((point) => [point.id, point]));
        markerPaths = allPaths.filter((path) => path.kind !== "quest-path");
        questPathByKey = new Map(allPaths
            .filter((path) => path.kind === "quest-path" && typeof path.pageTitle === "string")
            .map((path) => [path.pageTitle, path]));
    }
    else {
        const locationsArr = normalizeLocations(locationRaw);
        markerLocations = locationsArr
            .filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.z))
            .map((entry, index) => ({
            id: `legacy:${index}:${entry.x}:${entry.z}`,
            name: entry.name,
            icon: entry.icon,
            kind: "location",
            pageTitles: [],
            sourceKinds: ["official-marker"],
            world: { x: entry.x, z: entry.z },
        }));
        markerPaths = [];
        questLocationById = new Map();
        questPathByKey = new Map();
        questOptions = [];
    }
    updateWorldBounds();
    buildLegend();
    syncQuestSelectionControl();
    buildQuestStageList();
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
function getScaleToFitViewport() {
    if (!MAP_IMAGE_CONTENT_BOX.width || !MAP_IMAGE_CONTENT_BOX.height) {
        return 1;
    }
    const fitScale = Math.min(viewportWidth / MAP_IMAGE_CONTENT_BOX.width, viewportHeight / MAP_IMAGE_CONTENT_BOX.height);
    return Math.max(0.1, fitScale);
}
function resetView() {
    scale = getScaleToFitViewport();
    minScale = scale * 0.4;
    maxScale = scale * 10;
    offsetX = (viewportWidth - MAP_IMAGE_CONTENT_BOX.width * scale) / 2 - MAP_IMAGE_CONTENT_BOX.left * scale;
    offsetY = (viewportHeight - MAP_IMAGE_CONTENT_BOX.height * scale) / 2 - MAP_IMAGE_CONTENT_BOX.top * scale;
    draw();
}
function zoomAt(screenX, screenY, zoomMultiplier) {
    const nextScale = Math.max(minScale, Math.min(maxScale, scale * zoomMultiplier));
    if (nextScale === scale) {
        return;
    }
    const nextView = zoomAtPoint({ x: screenX, y: screenY }, { scale, offsetX, offsetY }, nextScale);
    scale = nextView.scale;
    offsetX = nextView.offsetX;
    offsetY = nextView.offsetY;
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
        const projectedStart = worldToMapImage(territory.start);
        const projectedEnd = worldToMapImage(territory.end);
        const left = Math.min(projectedStart.x, projectedEnd.x);
        const top = Math.min(projectedStart.y, projectedEnd.y);
        const width = Math.abs(projectedEnd.x - projectedStart.x);
        const height = Math.abs(projectedEnd.y - projectedStart.y);
        const screen = imageToScreen({ x: left, y: top }, { scale, offsetX, offsetY });
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
function drawPaths() {
    if (activeOverlayMode === "quest") {
        const pointsToDraw = getVisibleQuestPathPoints();
        if (pointsToDraw.length < 2) {
            return;
        }
        ctx.beginPath();
        for (const [index, point] of pointsToDraw.entries()) {
            const image = worldToMapImage(point);
            const screen = imageToScreen(image, { scale, offsetX, offsetY });
            if (index === 0) {
                ctx.moveTo(screen.x, screen.y);
            }
            else {
                ctx.lineTo(screen.x, screen.y);
            }
        }
        ctx.lineWidth = Math.max(1.5, scale * 0.55);
        ctx.strokeStyle = "rgba(139, 92, 246, 0.72)";
        ctx.setLineDash([]);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
        return;
    }
    if (!pathsToggle.checked) {
        return;
    }
    for (const path of markerPaths) {
        if (!shouldRenderPath(path)) {
            continue;
        }
        const pointsToDraw = path.points.filter((point) => shouldShowOutOfBoundsMarkers() || isPointWithinMapBounds(point));
        if (pointsToDraw.length < 2) {
            continue;
        }
        ctx.beginPath();
        for (const [index, point] of pointsToDraw.entries()) {
            const image = worldToMapImage(point);
            const screen = imageToScreen(image, { scale, offsetX, offsetY });
            if (index === 0) {
                ctx.moveTo(screen.x, screen.y);
            }
            else {
                ctx.lineTo(screen.x, screen.y);
            }
        }
        ctx.lineWidth = path.kind === "quest-path" ? Math.max(1.5, scale * 0.55) : Math.max(1, scale * 0.35);
        ctx.strokeStyle = path.kind === "quest-path" ? "rgba(139, 92, 246, 0.72)" : "rgba(148, 163, 184, 0.55)";
        ctx.setLineDash(path.kind === "quest-path" ? [] : [5, 4]);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
    }
    ctx.setLineDash([]);
}
function drawLocations() {
    if (activeOverlayMode === "quest") {
        const activeQuestStages = getActiveQuestStageLocations();
        if (activeQuestStages.length === 0) {
            return;
        }
        const iconSize = Math.max(8, Math.min(48, locationIconSize));
        for (const { location, stageNumber } of activeQuestStages) {
            const image = worldToMapImage(location.world);
            const screen = imageToScreen(image, { scale, offsetX, offsetY });
            const isHoveredStage = hoveredQuestPointId === location.id;
            const drawSize = isHoveredStage ? Math.min(56, iconSize + 8) : iconSize;
            drawQuestStageMarker(screen.x, screen.y, drawSize, stageNumber, isHoveredStage);
            if (locationLabelsToggle.checked && scale > minScale * 2.1) {
                ctx.fillStyle = "#f1f5f9";
                ctx.font = `${Math.max(10, Math.min(14, scale * 0.9))}px sans-serif`;
                ctx.textAlign = "left";
                ctx.textBaseline = "alphabetic";
                const labelOffset = drawSize / 2;
                ctx.fillText(location.name, screen.x + labelOffset + 4, screen.y - labelOffset);
            }
        }
        return;
    }
    if (!locationsToggle.checked) {
        return;
    }
    const iconSize = Math.max(8, Math.min(48, locationIconSize));
    const halfIconSize = iconSize / 2;
    for (const location of markerLocations) {
        if (!shouldRenderLocation(location)) {
            continue;
        }
        const image = worldToMapImage(location.world);
        const screen = imageToScreen(image, { scale, offsetX, offsetY });
        const visual = classifyMarkerVisual(location);
        if (!isMarkerTypeEnabled(visual.key)) {
            continue;
        }
        drawMarkerShape(screen.x, screen.y, iconSize, visual);
        drawMarkerGlyph(screen.x, screen.y, iconSize, visual);
        if (locationLabelsToggle.checked && scale > minScale * 2.1) {
            ctx.fillStyle = "#f1f5f9";
            ctx.font = `${Math.max(10, Math.min(14, scale * 0.9))}px sans-serif`;
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            ctx.fillText(location.name, screen.x + halfIconSize + 4, screen.y - halfIconSize);
        }
    }
    for (const { quest, location } of getVisibleQuestStarts()) {
        const image = worldToMapImage(location.world);
        const screen = imageToScreen(image, { scale, offsetX, offsetY });
        const visual = classifyMarkerVisual(location);
        drawMarkerShape(screen.x, screen.y, iconSize, visual);
        drawMarkerGlyph(screen.x, screen.y, iconSize, visual);
        if (locationLabelsToggle.checked && scale > minScale * 2.1) {
            ctx.fillStyle = "#f1f5f9";
            ctx.font = `${Math.max(10, Math.min(14, scale * 0.9))}px sans-serif`;
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            const labelOffset = iconSize / 2;
            ctx.fillText(quest.label, screen.x + labelOffset + 4, screen.y - labelOffset);
        }
    }
}
function drawHoverLabel() {
    if (!hoveredLabel) {
        return;
    }
    const paddingX = 10;
    const margin = 12;
    const desktopMenuWidth = mobileMenuMediaQuery.matches ? 0 : questMenu.clientWidth;
    const mobileLeftInset = openMobileMenu === "markers" ? sideMenu.clientWidth : 0;
    const mobileRightInset = openMobileMenu === "quests" ? questMenu.clientWidth : 0;
    const reservedRight = desktopMenuWidth + mobileRightInset;
    const reservedLeft = mobileLeftInset;
    const availableWidth = Math.max(160, viewportWidth - reservedLeft - reservedRight - margin * 2);
    const maxLabelWidth = Math.min(420, availableWidth);
    const boxHeight = 26;
    ctx.font = "13px sans-serif";
    let label = hoveredLabel;
    let textWidth = ctx.measureText(label).width;
    if (textWidth > maxLabelWidth - paddingX * 2) {
        const ellipsis = "…";
        while (label.length > 1 && textWidth > maxLabelWidth - paddingX * 2) {
            label = `${label.slice(0, -2)}${ellipsis}`;
            textWidth = ctx.measureText(label).width;
        }
    }
    const boxWidth = Math.min(maxLabelWidth, Math.max(120, textWidth + paddingX * 2));
    const boxX = Math.max(margin + reservedLeft, viewportWidth - reservedRight - boxWidth - margin);
    const boxY = viewportHeight - boxHeight - margin;
    ctx.fillStyle = "rgba(0,0,0,0.78)";
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
    ctx.fillStyle = "#f8fafc";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(label, boxX + paddingX, boxY + 17);
}
function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(devicePixelRatioScale, 0, 0, devicePixelRatioScale, 0, 0);
    if (!mapImage.width || !mapImage.height) {
        return;
    }
    ctx.drawImage(mapImage, offsetX, offsetY, mapImage.width * scale, mapImage.height * scale);
    drawTerritories();
    drawPaths();
    drawLocations();
    drawHoverLabel();
}
function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    devicePixelRatioScale = dpr;
    viewportWidth = Math.max(1, canvas.clientWidth);
    viewportHeight = Math.max(1, canvas.clientHeight);
    canvas.width = Math.max(1, Math.floor(viewportWidth * dpr));
    canvas.height = Math.max(1, Math.floor(viewportHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    resetView();
}
function screenToWorld(screenX, screenY) {
    const imagePoint = screenToImage({ x: screenX, y: screenY }, { scale, offsetX, offsetY });
    return mapImageToWorld(imagePoint);
}
function updateHover(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const image = screenToImage({ x, y }, { scale, offsetX, offsetY });
    const world = screenToWorld(x, y);
    setCoordinateReadout(world, image);
    let bestDistance = Infinity;
    let bestName = "";
    const hoverLocations = activeOverlayMode === "quest"
        ? getActiveQuestLocations()
        : [...markerLocations, ...getVisibleQuestStarts().map((entry) => entry.location)];
    if ((activeOverlayMode === "quest" && hoverLocations.length > 0) || (activeOverlayMode === "marker" && locationsToggle.checked)) {
        for (const location of hoverLocations) {
            if (activeOverlayMode === "marker" && !shouldRenderLocation(location)) {
                continue;
            }
            if (activeOverlayMode === "quest" &&
                (!shouldShowOutOfBoundsMarkers() && !isPointWithinMapBounds(location.world))) {
                continue;
            }
            const visual = classifyMarkerVisual(location);
            if (activeOverlayMode === "marker" && !isMarkerTypeEnabled(visual.key)) {
                continue;
            }
            const dx = location.world.x - world.x;
            const dz = location.world.z - world.z;
            const distance = Math.hypot(dx, dz);
            if (distance < bestDistance && distance < 55 / Math.max(scale, 0.4)) {
                bestDistance = distance;
                const pageHint = location.pageTitles[0] && location.pageTitles[0] !== location.name ? ` • ${location.pageTitles[0]}` : "";
                bestName = `${location.name}${pageHint} (${Math.round(location.world.x)}, ${Math.round(location.world.z)})`;
            }
        }
    }
    hoveredLabel = bestName;
    draw();
}
function findClickedQuestStart(clientX, clientY) {
    if (activeOverlayMode !== "marker" || !locationsToggle.checked || !questStartsEnabled) {
        return null;
    }
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const hitRadius = Math.max(10, Math.min(28, locationIconSize * 0.85));
    let bestMatch = null;
    for (const entry of getVisibleQuestStarts()) {
        const image = worldToMapImage(entry.location.world);
        const screen = imageToScreen(image, { scale, offsetX, offsetY });
        const distance = Math.hypot(screen.x - x, screen.y - y);
        if (distance > hitRadius) {
            continue;
        }
        if (!bestMatch || distance < bestMatch.distance) {
            bestMatch = { quest: entry.quest, distance };
        }
    }
    return bestMatch?.quest ?? null;
}
function applyMobileMenuState() {
    const isMobileLayout = mobileMenuMediaQuery.matches;
    const isMarkerMenuOpen = isMobileLayout && openMobileMenu === "markers";
    const isQuestMenuOpen = isMobileLayout && openMobileMenu === "quests";
    const isAnyMenuOpen = isMarkerMenuOpen || isQuestMenuOpen;
    document.body.classList.toggle("mobile-menu-open", isAnyMenuOpen);
    document.body.classList.toggle("mobile-marker-menu-open", isMarkerMenuOpen);
    document.body.classList.toggle("mobile-quest-menu-open", isQuestMenuOpen);
    mobileMenuBackdrop.hidden = !isAnyMenuOpen;
    mobileMarkerMenuToggleBtn.setAttribute("aria-expanded", String(isMarkerMenuOpen));
    mobileQuestMenuToggleBtn.setAttribute("aria-expanded", String(isQuestMenuOpen));
    if (isMobileLayout) {
        sideMenu.setAttribute("aria-modal", "true");
        questMenu.setAttribute("aria-modal", "true");
    }
    else {
        sideMenu.removeAttribute("aria-modal");
        questMenu.removeAttribute("aria-modal");
    }
}
function setMobileMenuOpen(nextOpen) {
    if (!mobileMenuMediaQuery.matches) {
        openMobileMenu = null;
        applyMobileMenuState();
        return;
    }
    openMobileMenu = nextOpen;
    applyMobileMenuState();
    draw();
}
function syncMobileMenuForViewport() {
    if (!mobileMenuMediaQuery.matches) {
        openMobileMenu = null;
    }
    applyMobileMenuState();
    draw();
}
async function refreshCache() {
    const bundledCache = await loadBundledCache();
    const storedCache = getStoredCache();
    const bundledMs = Date.parse(bundledCache.updatedAt);
    const storedMs = storedCache ? Date.parse(storedCache.updatedAt) : Number.NaN;
    const baseCache = !storedCache || !Number.isFinite(storedMs) || bundledMs >= storedMs
        ? bundledCache
        : storedCache;
    applyRawData(baseCache.territoryRaw, baseCache.locationRaw, baseCache.mapData);
    const cacheStoreError = setStoredCache(baseCache);
    const totalVisiblePoints = markerLocations.length + questLocationById.size;
    const totalVisiblePaths = markerPaths.length + questPathByKey.size;
    const pathSummary = totalVisiblePaths > 0 ? `, ${totalVisiblePaths.toLocaleString()} paths` : "";
    const wikiSummary = baseCache.mapData?.stats && baseCache.mapData.stats.wikiCoordinateCount > 0
        ? `, ${baseCache.mapData.stats.wikiCoordinateCount.toLocaleString()} wiki coordinates`
        : "";
    const cacheStoreSummary = cacheStoreError ? ` Browser cache save skipped: ${cacheStoreError}.` : "";
    baseStatusMessage = `Loaded ${territories.length.toLocaleString()} territories, ${totalVisiblePoints.toLocaleString()} points${pathSummary}${wikiSummary} from cached data (${formatDateTime(baseCache.updatedAt)}).${cacheStoreSummary}`;
    updateStatus();
    draw();
}
canvas.addEventListener("pointerdown", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    isDragging = true;
    dragMoved = false;
    dragStartX = x - offsetX;
    dragStartY = y - offsetY;
    canvas.classList.add("dragging");
    canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (isDragging) {
        if (Math.abs(x - (dragStartX + offsetX)) > 4 || Math.abs(y - (dragStartY + offsetY)) > 4) {
            dragMoved = true;
        }
        offsetX = x - dragStartX;
        offsetY = y - dragStartY;
        draw();
    }
    else {
        updateHover(event.clientX, event.clientY);
    }
});
canvas.addEventListener("pointerup", (event) => {
    const clickedQuestStart = !dragMoved ? findClickedQuestStart(event.clientX, event.clientY) : null;
    isDragging = false;
    dragMoved = false;
    canvas.classList.remove("dragging");
    canvas.releasePointerCapture(event.pointerId);
    if (clickedQuestStart) {
        revealQuestStartInLeftMenu(clickedQuestStart.key);
        activateQuestFromStart(clickedQuestStart.key);
    }
});
canvas.addEventListener("pointercancel", (event) => {
    isDragging = false;
    dragMoved = false;
    canvas.classList.remove("dragging");
    canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener("pointerleave", () => {
    hoveredLabel = "";
    setCoordinateReadout();
    draw();
});
window.addEventListener("keydown", (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
        return;
    }
    if (event.key.toLowerCase() !== "c") {
        return;
    }
    const activeTag = document.activeElement instanceof HTMLElement ? document.activeElement.tagName : "";
    if (activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT") {
        return;
    }
    event.preventDefault();
    void copyCurrentCoordinates();
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
locationsToggle.addEventListener("change", () => {
    setActiveOverlayMode("marker");
});
pathsToggle.addEventListener("change", () => {
    setActiveOverlayMode("marker");
});
outOfBoundsMarkersToggle.addEventListener("change", () => {
    buildLegend();
    buildQuestStageList();
    if (activeOverlayMode === "quest" && selectedQuestKey) {
        hoveredQuestPointId = "";
        focusQuestOnMap();
        return;
    }
    draw();
});
locationLabelsToggle.addEventListener("change", draw);
questSelect.addEventListener("change", () => {
    selectedQuestKey = questSelect.value;
    hoveredQuestPointId = "";
    buildQuestStageList();
    if (selectedQuestKey) {
        setActiveOverlayMode("quest");
        focusQuestOnMap();
        setMobileMenuOpen(null);
        return;
    }
    updateStatus();
    draw();
});
clearQuestSelectionBtn.addEventListener("click", () => {
    selectedQuestKey = "";
    questSelect.value = "";
    hoveredQuestPointId = "";
    buildQuestStageList();
    updateStatus();
    draw();
});
locationIconSizeInput.addEventListener("input", () => {
    locationIconSize = Number(locationIconSizeInput.value) || 18;
    updateLocationIconSizeLabel();
    draw();
});
legendToggleAllBtn.addEventListener("click", () => {
    const checkboxes = markerLegend.querySelectorAll('input[data-type-key]');
    enabledMarkerTypes.clear();
    for (const checkbox of checkboxes) {
        checkbox.checked = !checkbox.checked;
        const typeKey = checkbox.dataset.typeKey;
        if (!typeKey) {
            continue;
        }
        if (typeKey === "quest") {
            questStartsEnabled = checkbox.checked;
            continue;
        }
        if (checkbox.checked) {
            enabledMarkerTypes.add(typeKey);
        }
    }
    buildLegend();
    if (activeOverlayMode !== "marker") {
        setActiveOverlayMode("marker");
        return;
    }
    updateStatus();
    hoveredLabel = "";
    draw();
});
sideMenu.addEventListener("change", () => {
    setActiveOverlayMode("marker");
});
sideMenu.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("button, input, label, summary")) {
        setActiveOverlayMode("marker");
    }
});
questMenu.addEventListener("change", () => {
    if (selectedQuestKey) {
        setActiveOverlayMode("quest");
        return;
    }
    updateStatus();
    draw();
});
questMenu.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("button, select, label") && selectedQuestKey) {
        setActiveOverlayMode("quest");
    }
});
mobileMarkerMenuToggleBtn.addEventListener("click", () => {
    setMobileMenuOpen(openMobileMenu === "markers" ? null : "markers");
});
mobileMenuCloseBtn.addEventListener("click", () => {
    setMobileMenuOpen(null);
});
mobileQuestMenuToggleBtn.addEventListener("click", () => {
    setMobileMenuOpen(openMobileMenu === "quests" ? null : "quests");
});
mobileQuestMenuCloseBtn.addEventListener("click", () => {
    setMobileMenuOpen(null);
});
mobileMenuBackdrop.addEventListener("click", () => {
    setMobileMenuOpen(null);
});
resetBtn.addEventListener("click", resetView);
window.addEventListener("resize", () => {
    syncMobileMenuForViewport();
    resizeCanvas();
});
mobileMenuMediaQuery.addEventListener("change", syncMobileMenuForViewport);
window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openMobileMenu) {
        setMobileMenuOpen(null);
    }
});
updateLocationIconSizeLabel();
setCoordinateReadout();
syncMobileMenuForViewport();
Promise.all([
    new Promise((resolve, reject) => {
        mapImage.onload = () => resolve();
        mapImage.onerror = () => reject(new Error("TopographicMap.png failed to load."));
    }),
    refreshCache(),
])
    .then(() => {
    resizeCanvas();
})
    .catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    setStatus(`Could not load map data: ${message}`);
    resizeCanvas();
});
