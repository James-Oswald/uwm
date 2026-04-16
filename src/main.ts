import { fitBoundsToAspect, imageToScreen, imageToWorld, screenToImage, worldToImage, zoomAt as zoomAtPoint } from "./alignment.js";
import type { Vec2 } from "./alignment.js";

type TerritoryData = {
  guild: {
    name: string;
    prefix: string;
  };
  location: {
    start: [number, number];
    end: [number, number];
  };
  acquired: string;
};

type LocationData = {
  name: string;
  icon: string;
  x: number;
  z: number;
};

type OverlayPoint = {
  id: string;
  name: string;
  icon: string;
  kind: string;
  pageTitles: string[];
  sourceKinds: string[];
  world: Vec2;
};

type CachedMapPoint = {
  id: string;
  name: string;
  icon: string;
  kind: string;
  x: number;
  y?: number | null;
  z: number;
  pageTitles?: string[];
  sourceKinds?: string[];
};

type CachedMapPath = {
  id: string;
  label: string;
  kind: string;
  pointIds: string[];
  pageId?: number;
  pageTitle?: string;
};

type CachedMapData = {
  points: CachedMapPoint[];
  paths: CachedMapPath[];
  pages?: Array<{
    id: string;
    pageId?: number;
    title: string;
    pageType: string;
    coordinateCount: number;
    pointIds?: string[];
  }>;
  stats?: {
    officialMarkerCount: number;
    wikiCoordinateCount: number;
    dedupedPointCount: number;
    pathCount: number;
    questPathCount: number;
  };
};

type OverlayPath = {
  id: string;
  label: string;
  kind: string;
  pageTitle?: string;
  points: Vec2[];
};

type QuestOption = {
  key: string;
  label: string;
  pageType: string;
  pointIds: string[];
  startPointId: string | null;
  pathId: string | null;
};

type MarkerVisual = {
  key: string;
  label: string;
  description: string;
  group: string;
  fill: string;
  stroke: string;
  glyph: string;
  shape: "circle" | "diamond" | "square" | "hex";
};

type OverlayTerritory = {
  name: string;
  guildName: string;
  guildPrefix: string;
  acquired: string;
  start: Vec2;
  end: Vec2;
};

type CachedPayload = {
  updatedAt: string;
  territoryRaw: unknown;
  locationRaw: unknown;
  wikiRaw?: unknown;
  mapData?: CachedMapData;
};

const MAP_IMAGE_URL = "./TopographicMap.png";
const BUNDLED_CACHE_URL = "./cache/wynn-data.json";
const CACHE_STORAGE_KEY = "wynn-map-cached-data";


const EMPTY_CACHE_PAYLOAD: CachedPayload = {
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

const colorCache = new Map<string, string>();

const canvas = document.querySelector<HTMLCanvasElement>("#map-canvas")!;
const territoriesToggle = document.querySelector<HTMLInputElement>("#toggle-territories")!;
const locationsToggle = document.querySelector<HTMLInputElement>("#toggle-locations")!;
const pathsToggle = document.querySelector<HTMLInputElement>("#toggle-paths")!;
const outOfBoundsMarkersToggle = document.querySelector<HTMLInputElement>("#toggle-out-of-bounds-markers")!;
const locationLabelsToggle = document.querySelector<HTMLInputElement>("#toggle-location-labels")!;
const locationIconSizeInput = document.querySelector<HTMLInputElement>("#location-icon-size")!;
const locationIconSizeValue = document.querySelector<HTMLOutputElement>("#location-icon-size-value")!;
const questSelect = document.querySelector<HTMLSelectElement>("#quest-select")!;
const markerLegend = document.querySelector<HTMLDivElement>("#marker-legend")!;
const legendToggleAllBtn = document.querySelector<HTMLButtonElement>("#legend-toggle-all")!;
const mobileMenuToggleBtn = document.querySelector<HTMLButtonElement>("#mobile-menu-toggle")!;
const mobileMenuCloseBtn = document.querySelector<HTMLButtonElement>("#mobile-menu-close")!;
const mobileMenuBackdrop = document.querySelector<HTMLDivElement>("#mobile-menu-backdrop")!;
const sideMenu = document.querySelector<HTMLElement>("#side-menu")!;
const mouseWorldCoordsEl = document.querySelector<HTMLSpanElement>("#mouse-world-coords")!;
const mouseImageCoordsEl = document.querySelector<HTMLSpanElement>("#mouse-image-coords")!;
const resetBtn = document.querySelector<HTMLButtonElement>("#reset-view")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;

const ctx = canvas.getContext("2d")!;

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

let territories: OverlayTerritory[] = [];
let locations: OverlayPoint[] = [];
let paths: OverlayPath[] = [];
let bounds = { ...MAP_WORLD_BOUNDS };
let hoveredLabel = "";
let viewportWidth = 0;
let viewportHeight = 0;
let devicePixelRatioScale = 1;
let locationIconSize = Number(locationIconSizeInput.value) || 18;
let lastPointerWorld: { x: number; z: number } | null = null;
let lastPointerImage: { x: number; y: number } | null = null;
const enabledMarkerTypes = new Set<string>();
let hasInitializedMarkerTypes = false;
let questOptions: QuestOption[] = [];
let selectedQuestKey = "";
let baseStatusMessage = "Loading map data...";
let isMobileMenuOpen = false;

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
] as const;

const MARKER_GROUP_ORDER = [
  "activities",
  "travel",
  "vendors",
  "services",
  "crafting",
  "hazards",
  "other",
] as const;

const MARKER_GROUP_META: Record<string, { label: string; description: string }> = {
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

function worldToMapImage(point: Vec2): { x: number; y: number } {
  return {
    x:
      point.x * MAP_CALIBRATION.imageXFromWorldX +
      point.z * MAP_CALIBRATION.imageXFromWorldZ +
      MAP_CALIBRATION.imageXOffset,
    y:
      point.x * MAP_CALIBRATION.imageYFromWorldX +
      point.z * MAP_CALIBRATION.imageYFromWorldZ +
      MAP_CALIBRATION.imageYOffset,
  };
}

function mapImageToWorld(point: { x: number; y: number }): { x: number; z: number } {
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

function updateLocationIconSizeLabel(): void {
  locationIconSizeValue.value = `${locationIconSize}px`;
  locationIconSizeValue.textContent = `${locationIconSize}px`;
}

function isPointWithinMapBounds(point: Vec2): boolean {
  return (
    point.x >= MAP_WORLD_BOUNDS.minX &&
    point.x <= MAP_WORLD_BOUNDS.maxX &&
    point.z >= MAP_WORLD_BOUNDS.minZ &&
    point.z <= MAP_WORLD_BOUNDS.maxZ
  );
}

function shouldShowOutOfBoundsMarkers(): boolean {
  return outOfBoundsMarkersToggle.checked;
}

function setCoordinateReadout(world?: { x: number; z: number }, image?: { x: number; y: number }): void {
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

async function copyCurrentCoordinates(): Promise<void> {
  if (!lastPointerWorld || !lastPointerImage) {
    setStatus("Move the mouse over the map before copying coordinates.");
    return;
  }

  const payload =
    `Map: x ${Math.round(lastPointerWorld.x)}, z ${Math.round(lastPointerWorld.z)}\n` +
    `Image: x ${Math.round(lastPointerImage.x)}, y ${Math.round(lastPointerImage.y)}`;

  try {
    await navigator.clipboard.writeText(payload);
    setStatus(`Copied calibration coordinates. Press "c" over the map to copy again.`);
  } catch {
    setStatus("Could not copy coordinates to the clipboard.");
  }
}

function classifyMarkerVisual(location: OverlayPoint): MarkerVisual {
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
  if (
    icon.includes("merchant_scroll") ||
    icon.includes("scroll") ||
    name.includes("scroll merchant") ||
    name.includes("scrolls")
  ) {
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

function drawMarkerShape(screenX: number, screenY: number, size: number, visual: MarkerVisual): void {
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
        } else {
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

function drawMarkerGlyph(screenX: number, screenY: number, size: number, visual: MarkerVisual): void {
  ctx.fillStyle = visual.stroke;
  ctx.font = `700 ${Math.max(8, size * 0.7)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(visual.glyph, screenX, screenY + size * 0.02);
}

function isMarkerTypeEnabled(typeKey: string): boolean {
  return enabledMarkerTypes.has(typeKey);
}

function buildLegend(): void {
  const counts = new Map<string, { visual: MarkerVisual; count: number }>();

  for (const location of locations) {
    if (!shouldShowOutOfBoundsMarkers() && !isPointWithinMapBounds(location.world)) {
      continue;
    }
    const visual = classifyMarkerVisual(location);
    const current = counts.get(visual.key);
    if (current) {
      current.count += 1;
    } else {
      counts.set(visual.key, { visual, count: 1 });
    }
  }

  const entries = [...counts.values()].sort((a, b) => {
    const orderA = MARKER_TYPE_ORDER.indexOf(a.visual.key as (typeof MARKER_TYPE_ORDER)[number]);
    const orderB = MARKER_TYPE_ORDER.indexOf(b.visual.key as (typeof MARKER_TYPE_ORDER)[number]);
    const normalizedA = orderA === -1 ? Number.MAX_SAFE_INTEGER : orderA;
    const normalizedB = orderB === -1 ? Number.MAX_SAFE_INTEGER : orderB;
    return normalizedA - normalizedB || a.visual.label.localeCompare(b.visual.label);
  });

  if (!hasInitializedMarkerTypes) {
    for (const entry of entries) {
      enabledMarkerTypes.add(entry.visual.key);
    }
    hasInitializedMarkerTypes = true;
  }

  const grouped = new Map<string, typeof entries>();
  for (const entry of entries) {
    const groupEntries = grouped.get(entry.visual.group);
    if (groupEntries) {
      groupEntries.push(entry);
    } else {
      grouped.set(entry.visual.group, [entry]);
    }
  }

  markerLegend.replaceChildren();

  const orderedGroups = [...grouped.entries()].sort((a, b) => {
    const orderA = MARKER_GROUP_ORDER.indexOf(a[0] as (typeof MARKER_GROUP_ORDER)[number]);
    const orderB = MARKER_GROUP_ORDER.indexOf(b[0] as (typeof MARKER_GROUP_ORDER)[number]);
    const normalizedA = orderA === -1 ? Number.MAX_SAFE_INTEGER : orderA;
    const normalizedB = orderB === -1 ? Number.MAX_SAFE_INTEGER : orderB;
    return normalizedA - normalizedB;
  });

  for (const [groupKey, groupEntries] of orderedGroups) {
    const details = document.createElement("details");
    details.className = "legend-group";
    details.open = true;

    const summary = document.createElement("summary");
    summary.className = "legend-group-summary";

    const groupToggle = document.createElement("input");
    groupToggle.type = "checkbox";
    groupToggle.className = "legend-group-toggle";
    groupToggle.addEventListener("click", (event) => {
      event.stopPropagation();
    });

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
    groupCount.textContent = groupEntries.reduce((sum, entry) => sum + entry.count, 0).toLocaleString();

    const groupList = document.createElement("div");
    groupList.className = "legend-group-list";
    const itemCheckboxes: HTMLInputElement[] = [];

    const syncGroupToggle = (): void => {
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
        if (groupToggle.checked) {
          enabledMarkerTypes.add(typeKey);
        } else {
          enabledMarkerTypes.delete(typeKey);
        }
      }
      syncGroupToggle();
      draw();
    });

    summary.append(groupToggle, groupMeta, groupCount);
    details.append(summary);

    for (const entry of groupEntries) {
      const row = document.createElement("label");
      row.className = "legend-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.typeKey = entry.visual.key;
      checkbox.checked = enabledMarkerTypes.has(entry.visual.key);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          enabledMarkerTypes.add(entry.visual.key);
        } else {
          enabledMarkerTypes.delete(entry.visual.key);
        }
        syncGroupToggle();
        draw();
      });
      itemCheckboxes.push(checkbox);

      const symbol = document.createElement("span");
      symbol.className = `legend-symbol shape-${entry.visual.shape}`;
      symbol.style.background = entry.visual.fill;
      symbol.style.border = `2px solid ${entry.visual.stroke}`;
      symbol.style.color = entry.visual.stroke;

      const symbolText = document.createElement("span");
      symbolText.textContent = entry.visual.glyph;
      symbol.append(symbolText);

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

      row.append(checkbox, symbol, meta, count);
      groupList.append(row);
    }

    syncGroupToggle();
    details.append(groupList);
    markerLegend.append(details);
  }
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function updateStatus(): void {
  const questMessage = selectedQuestKey
    ? ` Showing all quest points for ${selectedQuestKey}.`
    : questOptions.length > 0
      ? " Showing the start point for every quest."
      : "";
  setStatus(`${baseStatusMessage}${questMessage}`);
}

async function loadBundledCache(): Promise<CachedPayload> {
  try {
    const response = await fetch(BUNDLED_CACHE_URL, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      return EMPTY_CACHE_PAYLOAD;
    }
    return (await response.json()) as CachedPayload;
  } catch {
    return EMPTY_CACHE_PAYLOAD;
  }
}

function getStoredCache(): CachedPayload | null {
  try {
    const raw = localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as CachedPayload;
  } catch {
    return null;
  }
}

function setStoredCache(payload: CachedPayload): string | null {
  try {
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(payload));
    return null;
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    return "Unknown cache storage error";
  }
}

function normalizeTerritories(territoryRaw: unknown): Record<string, TerritoryData> {
  if (!territoryRaw || typeof territoryRaw !== "object") {
    return {};
  }

  const rawObj = territoryRaw as Record<string, unknown>;
  const territoriesContainer =
    (typeof rawObj.territories === "object" && rawObj.territories) ||
    (typeof rawObj.results === "object" && rawObj.results) ||
    rawObj;

  const entries = Object.entries(territoriesContainer as Record<string, unknown>).filter(([, value]) => {
    if (!value || typeof value !== "object") {
      return false;
    }
    const location = (value as TerritoryData).location;
    return Array.isArray(location?.start) && Array.isArray(location?.end);
  });

  return Object.fromEntries(entries) as Record<string, TerritoryData>;
}

function normalizeLocations(locationRaw: unknown): LocationData[] {
  const collected: LocationData[] = [];
  const seen = new Set<string>();

  const pushCandidate = (name: string, icon: string, x: unknown, z: unknown): void => {
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

  const pushFromTuple = (name: string, icon: string, tuple: unknown[]): void => {
    if (tuple.length < 2) {
      return;
    }
    if (tuple.length >= 3) {
      pushCandidate(name, icon, tuple[0], tuple[2]);
      return;
    }
    pushCandidate(name, icon, tuple[0], tuple[1]);
  };

  const pushFromCoordinateString = (name: string, icon: string, rawValue: unknown): void => {
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

  const visit = (value: unknown, fallbackName: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, fallbackName);
      }
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    const obj = value as Record<string, unknown>;
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
    } else if ("x" in obj && "y" in obj) {
      pushCandidate(name, icon, obj.x, obj.y);
    } else if ("latitude" in obj && "longitude" in obj) {
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
      if (
        key === "name" ||
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
        key === "longitude"
      ) {
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

  const rawObj = locationRaw as Record<string, unknown>;
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

function normalizeMapData(mapData: CachedPayload["mapData"]): CachedMapData | null {
  if (!mapData || typeof mapData !== "object") {
    return null;
  }

  const raw = mapData as CachedMapData;
  if (!Array.isArray(raw.points) || !Array.isArray(raw.paths)) {
    return null;
  }

  return raw;
}

function buildQuestOptions(normalizedMapData: CachedMapData | null): QuestOption[] {
  if (!normalizedMapData?.pages?.length) {
    return [];
  }

  const questPathByTitle = new Map(
    normalizedMapData.paths
      .filter((path) => path.kind === "quest-path" && typeof path.pageTitle === "string")
      .map((path) => [path.pageTitle as string, path]),
  );

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

function syncQuestSelectionControl(): void {
  const validQuestKeys = new Set(questOptions.map((quest) => quest.key));
  if (selectedQuestKey && !validQuestKeys.has(selectedQuestKey)) {
    selectedQuestKey = "";
  }

  questSelect.replaceChildren();

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "All quest starts";
  questSelect.append(defaultOption);

  for (const quest of questOptions) {
    const option = document.createElement("option");
    option.value = quest.key;
    option.textContent = quest.label;
    questSelect.append(option);
  }

  questSelect.value = selectedQuestKey;
}

function shouldRenderLocation(location: OverlayPoint): boolean {
  if (!shouldShowOutOfBoundsMarkers() && !isPointWithinMapBounds(location.world)) {
    return false;
  }

  if (selectedQuestKey) {
    const selectedQuest = questOptions.find((quest) => quest.key === selectedQuestKey);
    return Boolean(selectedQuest && selectedQuest.pointIds.includes(location.id));
  }

  if (location.kind !== "quest") {
    return true;
  }

  return questOptions.some((quest) => quest.startPointId === location.id);
}

function shouldRenderPath(path: OverlayPath): boolean {
  if (!selectedQuestKey) {
    return path.kind !== "quest-path";
  }

  return path.kind === "quest-path" && path.pageTitle === selectedQuestKey;
}

function applyRawData(territoryRaw: unknown, locationRaw: unknown, mapData?: CachedPayload["mapData"]): void {
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
    const pointById = new Map<string, OverlayPoint>();

    locations = normalizedMapData.points
      .filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.z))
      .map((entry) => {
        const point: OverlayPoint = {
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
    paths = normalizedMapData.paths
      .map((path) => ({
        id: path.id,
        label: path.label,
        kind: path.kind,
        pageTitle: path.pageTitle,
        points: path.pointIds
          .map((pointId) => pointById.get(pointId)?.world)
          .filter((point): point is Vec2 => Boolean(point)),
      }))
      .filter((path) => path.points.length >= 2);

    questOptions = buildQuestOptions(normalizedMapData);
  } else {
    const locationsArr = normalizeLocations(locationRaw);

    locations = locationsArr
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
    paths = [];
    questOptions = [];
  }

  updateWorldBounds();
  buildLegend();
  syncQuestSelectionControl();
}

function formatDateTime(isoDate: string): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return "unknown";
  }
  return parsed.toLocaleString();
}

function updateWorldBounds(): void {
  bounds = { ...MAP_WORLD_BOUNDS };
}


function getScaleToFitViewport(): number {
  if (!MAP_IMAGE_CONTENT_BOX.width || !MAP_IMAGE_CONTENT_BOX.height) {
    return 1;
  }
  const fitScale = Math.min(viewportWidth / MAP_IMAGE_CONTENT_BOX.width, viewportHeight / MAP_IMAGE_CONTENT_BOX.height);
  return Math.max(0.1, fitScale);
}

function resetView(): void {
  scale = getScaleToFitViewport();
  minScale = scale * 0.4;
  maxScale = scale * 10;
  offsetX = (viewportWidth - MAP_IMAGE_CONTENT_BOX.width * scale) / 2 - MAP_IMAGE_CONTENT_BOX.left * scale;
  offsetY = (viewportHeight - MAP_IMAGE_CONTENT_BOX.height * scale) / 2 - MAP_IMAGE_CONTENT_BOX.top * scale;
  draw();
}

function zoomAt(screenX: number, screenY: number, zoomMultiplier: number): void {
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

function colorForGuild(prefix: string): string {
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

function drawTerritories(): void {
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
      ctx.fillText(
        territory.name,
        screen.x + 4,
        screen.y + Math.max(12, Math.min(16, screenHeight - 4)),
      );
    }
  }

  ctx.globalAlpha = 1;
}

function drawPaths(): void {
  if (!selectedQuestKey && !pathsToggle.checked) {
    return;
  }

  for (const path of paths) {
    if (!shouldRenderPath(path)) {
      continue;
    }
    const pointsToDraw = shouldShowOutOfBoundsMarkers()
      ? path.points.filter((point) => isPointWithinMapBounds(point))
      : path.points;
    if (pointsToDraw.length < 2) {
      continue;
    }
    ctx.beginPath();

    for (const [index, point] of pointsToDraw.entries()) {
      const image = worldToMapImage(point);
      const screen = imageToScreen(image, { scale, offsetX, offsetY });
      if (index === 0) {
        ctx.moveTo(screen.x, screen.y);
      } else {
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

function drawLocations(): void {
  if (!selectedQuestKey && !locationsToggle.checked) {
    return;
  }

  const iconSize = Math.max(8, Math.min(48, locationIconSize));
  const halfIconSize = iconSize / 2;

  for (const location of locations) {
    if (!shouldRenderLocation(location)) {
      continue;
    }
    const image = worldToMapImage(location.world);
    const screen = imageToScreen(image, { scale, offsetX, offsetY });
    const visual = classifyMarkerVisual(location);
    if (!selectedQuestKey && !isMarkerTypeEnabled(visual.key)) {
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
}

function drawHoverLabel(): void {
  if (!hoveredLabel) {
    return;
  }

  const paddingX = 10;
  const margin = 12;
  const maxLabelWidth = Math.min(420, viewportWidth - margin * 2);
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
  const boxX = viewportWidth - boxWidth - margin;
  const boxY = viewportHeight - boxHeight - margin;

  ctx.fillStyle = "rgba(0,0,0,0.78)";
  ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
  ctx.fillStyle = "#f8fafc";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(label, boxX + paddingX, boxY + 17);
}

function draw(): void {
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

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  devicePixelRatioScale = dpr;
  viewportWidth = Math.max(1, canvas.clientWidth);
  viewportHeight = Math.max(1, canvas.clientHeight);
  canvas.width = Math.max(1, Math.floor(viewportWidth * dpr));
  canvas.height = Math.max(1, Math.floor(viewportHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  resetView();
}

function screenToWorld(screenX: number, screenY: number): { x: number; z: number } {
  const imagePoint = screenToImage({ x: screenX, y: screenY }, { scale, offsetX, offsetY });
  return mapImageToWorld(imagePoint);
}

function updateHover(clientX: number, clientY: number): void {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const image = screenToImage({ x, y }, { scale, offsetX, offsetY });
  const world = screenToWorld(x, y);
  setCoordinateReadout(world, image);

  let bestDistance = Infinity;
  let bestName = "";

  if (selectedQuestKey || locationsToggle.checked) {
    for (const location of locations) {
      if (!shouldRenderLocation(location)) {
        continue;
      }
      const visual = classifyMarkerVisual(location);
      if (!selectedQuestKey && !isMarkerTypeEnabled(visual.key)) {
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

function applyMobileMenuState(): void {
  const isMobileLayout = mobileMenuMediaQuery.matches;
  document.body.classList.toggle("mobile-menu-open", isMobileLayout && isMobileMenuOpen);
  mobileMenuBackdrop.hidden = !(isMobileLayout && isMobileMenuOpen);
  mobileMenuToggleBtn.setAttribute("aria-expanded", String(isMobileLayout && isMobileMenuOpen));

  if (isMobileLayout) {
    sideMenu.setAttribute("aria-modal", "true");
  } else {
    sideMenu.removeAttribute("aria-modal");
  }
}

function setMobileMenuOpen(nextOpen: boolean): void {
  if (!mobileMenuMediaQuery.matches) {
    isMobileMenuOpen = false;
    applyMobileMenuState();
    return;
  }

  isMobileMenuOpen = nextOpen;
  applyMobileMenuState();
}

function syncMobileMenuForViewport(): void {
  if (!mobileMenuMediaQuery.matches) {
    isMobileMenuOpen = false;
  }
  applyMobileMenuState();
}

async function refreshCache(): Promise<void> {
  const bundledCache = await loadBundledCache();
  const storedCache = getStoredCache();
  const bundledMs = Date.parse(bundledCache.updatedAt);
  const storedMs = storedCache ? Date.parse(storedCache.updatedAt) : Number.NaN;
  const baseCache =
    !storedCache || !Number.isFinite(storedMs) || bundledMs >= storedMs
      ? bundledCache
      : storedCache;

  applyRawData(baseCache.territoryRaw, baseCache.locationRaw, baseCache.mapData);
  const cacheStoreError = setStoredCache(baseCache);
  const pathSummary = paths.length > 0 ? `, ${paths.length.toLocaleString()} paths` : "";
  const wikiSummary =
    baseCache.mapData?.stats && baseCache.mapData.stats.wikiCoordinateCount > 0
      ? `, ${baseCache.mapData.stats.wikiCoordinateCount.toLocaleString()} wiki coordinates`
      : "";
  const cacheStoreSummary = cacheStoreError ? ` Browser cache save skipped: ${cacheStoreError}.` : "";
  baseStatusMessage = `Loaded ${territories.length.toLocaleString()} territories, ${locations.length.toLocaleString()} points${pathSummary}${wikiSummary} from cached data (${formatDateTime(baseCache.updatedAt)}).${cacheStoreSummary}`;
  updateStatus();
  draw();
}

canvas.addEventListener("pointerdown", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  isDragging = true;
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
    offsetX = x - dragStartX;
    offsetY = y - dragStartY;
    draw();
  } else {
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

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const delta = Math.sign(event.deltaY);
    const factor = delta < 0 ? 1.1 : 0.9;
    zoomAt(x, y, factor);
  },
  { passive: false },
);

territoriesToggle.addEventListener("change", draw);
locationsToggle.addEventListener("change", draw);
pathsToggle.addEventListener("change", draw);
outOfBoundsMarkersToggle.addEventListener("change", () => {
  buildLegend();
  draw();
});
locationLabelsToggle.addEventListener("change", draw);
questSelect.addEventListener("change", () => {
  selectedQuestKey = questSelect.value;
  updateStatus();
  draw();
});
locationIconSizeInput.addEventListener("input", () => {
  locationIconSize = Number(locationIconSizeInput.value) || 18;
  updateLocationIconSizeLabel();
  draw();
});
legendToggleAllBtn.addEventListener("click", () => {
  const checkboxes = markerLegend.querySelectorAll<HTMLInputElement>('input[data-type-key]');
  const groupToggles = markerLegend.querySelectorAll<HTMLInputElement>("input.legend-group-toggle");
  const shouldEnableAll = [...checkboxes].some((checkbox) => !checkbox.checked);
  enabledMarkerTypes.clear();
  for (const checkbox of checkboxes) {
    checkbox.checked = shouldEnableAll;
    if (shouldEnableAll) {
      const typeKey = checkbox.dataset.typeKey;
      if (typeKey) {
        enabledMarkerTypes.add(typeKey);
      }
    }
  }
  for (const groupToggle of groupToggles) {
    groupToggle.checked = shouldEnableAll;
    groupToggle.indeterminate = false;
  }
  draw();
});
mobileMenuToggleBtn.addEventListener("click", () => {
  setMobileMenuOpen(!isMobileMenuOpen);
});
mobileMenuCloseBtn.addEventListener("click", () => {
  setMobileMenuOpen(false);
});
mobileMenuBackdrop.addEventListener("click", () => {
  setMobileMenuOpen(false);
});
resetBtn.addEventListener("click", resetView);
window.addEventListener("resize", () => {
  syncMobileMenuForViewport();
  resizeCanvas();
});
mobileMenuMediaQuery.addEventListener("change", syncMobileMenuForViewport);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isMobileMenuOpen) {
    setMobileMenuOpen(false);
  }
});

updateLocationIconSizeLabel();
setCoordinateReadout();
syncMobileMenuForViewport();

Promise.all([
  new Promise<void>((resolve, reject) => {
    mapImage.onload = () => resolve();
    mapImage.onerror = () => reject(new Error("TopographicMap.png failed to load."));
  }),
  refreshCache(),
])
  .then(() => {
    resizeCanvas();
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    setStatus(`Could not load map data: ${message}`);
    resizeCanvas();
  });
