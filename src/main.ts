type Vec2 = { x: number; z: number };

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
  name: string;
  icon: string;
  world: Vec2;
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
  territoryRaw: Record<string, TerritoryData>;
  locationRaw: LocationData[] | { locations: LocationData[] };
};

const MAP_IMAGE_URL = "./TopographicMap.png";
const API_ORIGIN = "https://api.wynncraft.com/v3";
const TERRITORY_CANDIDATES = [`${API_ORIGIN}/guild/list/territory`, `${API_ORIGIN}/guild/territory`];
const LOCATION_CANDIDATES = [`${API_ORIGIN}/map/locations`, `${API_ORIGIN}/map`];
const BUNDLED_CACHE_URL = "./cache/wynn-data.json";
const CACHE_STORAGE_KEY = "wynn-map-cached-data";
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;


const EMPTY_CACHE_PAYLOAD: CachedPayload = {
  updatedAt: new Date(0).toISOString(),
  territoryRaw: {},
  locationRaw: [],
};

const WORLD_BOUNDS_FALLBACK = {
  minX: -2200,
  maxX: 2200,
  minZ: -2400,
  maxZ: 2400,
};

const colorCache = new Map<string, string>();

const canvas = document.querySelector<HTMLCanvasElement>("#map-canvas")!;
const territoriesToggle = document.querySelector<HTMLInputElement>("#toggle-territories")!;
const locationsToggle = document.querySelector<HTMLInputElement>("#toggle-locations")!;
const refreshCacheBtn = document.querySelector<HTMLButtonElement>("#refresh-cache")!;
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
let bounds = { ...WORLD_BOUNDS_FALLBACK };
let hoveredLabel = "";

function setStatus(message: string): void {
  statusEl.textContent = message;
}

async function fetchFirstJson<T>(urls: string[]): Promise<T> {
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        failures.push(`${url} [${response.status}]`);
        continue;
      }
      return (await response.json()) as T;
    } catch {
      failures.push(`${url} [network-error]`);
    }
  }
  throw new Error(`All endpoint attempts failed: ${failures.join(", ")}`);
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

function setStoredCache(payload: CachedPayload): void {
  localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(payload));
}

function applyRawData(
  territoryRaw: Record<string, TerritoryData>,
  locationRaw: LocationData[] | { locations: LocationData[] },
): void {
  territories = Object.entries(territoryRaw).map(([name, value]) => ({
    name,
    guildName: value.guild?.name ?? "Unknown guild",
    guildPrefix: value.guild?.prefix ?? "",
    acquired: value.acquired,
    start: { x: value.location.start[0], z: value.location.start[1] },
    end: { x: value.location.end[0], z: value.location.end[1] },
  }));

  const locationsArr = Array.isArray(locationRaw)
    ? locationRaw
    : Array.isArray(locationRaw.locations)
      ? locationRaw.locations
      : [];

  locations = locationsArr
    .filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.z))
    .map((entry) => ({
      name: entry.name,
      icon: entry.icon,
      world: { x: entry.x, z: entry.z },
    }));

  updateWorldBounds();
}

function isCacheStale(updatedAt: string): boolean {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) {
    return true;
  }
  return Date.now() - updatedMs >= CACHE_MAX_AGE_MS;
}

function formatDateTime(isoDate: string): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return "unknown";
  }
  return parsed.toLocaleString();
}

function updateWorldBounds(): void {
  const xs: number[] = [];
  const zs: number[] = [];

  for (const territory of territories) {
    xs.push(territory.start.x, territory.end.x);
    zs.push(territory.start.z, territory.end.z);
  }

  for (const location of locations) {
    xs.push(location.world.x);
    zs.push(location.world.z);
  }

  if (xs.length > 0 && zs.length > 0) {
    const padding = 60;
    bounds = {
      minX: Math.min(...xs) - padding,
      maxX: Math.max(...xs) + padding,
      minZ: Math.min(...zs) - padding,
      maxZ: Math.max(...zs) + padding,
    };
  } else {
    bounds = { ...WORLD_BOUNDS_FALLBACK };
  }
}

function worldToImage(point: Vec2): { x: number; y: number } {
  const xRatio = (point.x - bounds.minX) / (bounds.maxX - bounds.minX);
  const zRatio = (point.z - bounds.minZ) / (bounds.maxZ - bounds.minZ);

  return {
    x: xRatio * mapImage.width,
    y: (1 - zRatio) * mapImage.height,
  };
}

function imageToScreen(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: point.x * scale + offsetX,
    y: point.y * scale + offsetY,
  };
}

function getScaleToFitViewport(): number {
  if (!mapImage.width || !mapImage.height) {
    return 1;
  }
  const fitScale = Math.min(canvas.width / mapImage.width, canvas.height / mapImage.height);
  return Math.max(0.1, fitScale);
}

function resetView(): void {
  scale = getScaleToFitViewport();
  minScale = scale * 0.4;
  maxScale = scale * 10;
  offsetX = (canvas.width - mapImage.width * scale) / 2;
  offsetY = (canvas.height - mapImage.height * scale) / 2;
  draw();
}

function zoomAt(screenX: number, screenY: number, zoomMultiplier: number): void {
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
      ctx.fillText(
        territory.guildPrefix || territory.guildName,
        screen.x + 4,
        screen.y + Math.max(12, Math.min(16, screenHeight - 4)),
      );
    }
  }

  ctx.globalAlpha = 1;
}

function drawLocations(): void {
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

function drawHoverLabel(): void {
  if (!hoveredLabel) {
    return;
  }
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(10, canvas.height - 36, Math.min(canvas.width - 20, 420), 26);
  ctx.fillStyle = "#f8fafc";
  ctx.font = "13px sans-serif";
  ctx.fillText(hoveredLabel, 16, canvas.height - 19);
}

function draw(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!mapImage.width || !mapImage.height) {
    return;
  }

  ctx.drawImage(mapImage, offsetX, offsetY, mapImage.width * scale, mapImage.height * scale);
  drawTerritories();
  drawLocations();
  drawHoverLabel();
}

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  resetView();
}

function screenToWorld(screenX: number, screenY: number): Vec2 {
  const imageX = (screenX - offsetX) / scale;
  const imageY = (screenY - offsetY) / scale;

  const x = bounds.minX + (imageX / mapImage.width) * (bounds.maxX - bounds.minX);
  const z = bounds.maxZ - (imageY / mapImage.height) * (bounds.maxZ - bounds.minZ);
  return { x, z };
}

function updateHover(clientX: number, clientY: number): void {
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

async function tryFetchLivePayload(): Promise<CachedPayload> {
  const [territoryRaw, locationRaw] = await Promise.all([
    fetchFirstJson<Record<string, TerritoryData>>(TERRITORY_CANDIDATES),
    fetchFirstJson<LocationData[] | { locations: LocationData[] }>(LOCATION_CANDIDATES),
  ]);

  return {
    updatedAt: new Date().toISOString(),
    territoryRaw,
    locationRaw,
  };
}

async function refreshCache(forceRefresh: boolean): Promise<void> {
  const bundledCache = await loadBundledCache();
  const storedCache = getStoredCache();
  const baseCache = storedCache ?? bundledCache;

  applyRawData(baseCache.territoryRaw, baseCache.locationRaw);
  setStatus(
    `Loaded ${territories.length.toLocaleString()} territories and ${locations.length.toLocaleString()} locations from cached data (${formatDateTime(baseCache.updatedAt)}).`,
  );

  const shouldRefresh = forceRefresh || isCacheStale(baseCache.updatedAt);
  if (!shouldRefresh) {
    return;
  }

  setStatus("Refreshing cache from Wynncraft API...");
  try {
    const freshPayload = await tryFetchLivePayload();
    setStoredCache(freshPayload);
    applyRawData(freshPayload.territoryRaw, freshPayload.locationRaw);
    setStatus(
      `Live refresh succeeded. Loaded ${territories.length.toLocaleString()} territories and ${locations.length.toLocaleString()} locations (${formatDateTime(freshPayload.updatedAt)}).`,
    );
    draw();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    setStatus(
      `Using cached data from ${formatDateTime(baseCache.updatedAt)} (live refresh failed due to CORS/API issue: ${message}).`,
    );
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
refreshCacheBtn.addEventListener("click", () => {
  void refreshCache(true);
});
resetBtn.addEventListener("click", resetView);
window.addEventListener("resize", resizeCanvas);

Promise.all([
  new Promise<void>((resolve, reject) => {
    mapImage.onload = () => resolve();
    mapImage.onerror = () => reject(new Error("TopographicMap.png failed to load."));
  }),
  refreshCache(false),
])
  .then(() => {
    resizeCanvas();
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    setStatus(`Could not load map data: ${message}`);
    resizeCanvas();
  });
