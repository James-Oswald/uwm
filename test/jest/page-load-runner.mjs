import path from "node:path";
import { pathToFileURL } from "node:url";

class MockClassList {
  add() {}
  remove() {}
  toggle() {
    return false;
  }
}

class MockElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = new MockClassList();
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.clientWidth = 1024;
    this.clientHeight = 768;
    this.width = 1024;
    this.height = 768;
  }

  addEventListener() {}
  removeEventListener() {}
  append(...children) {
    this.children.push(...children);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...children) {
    this.children = [...children];
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  closest() {
    return null;
  }
  querySelector() {
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  getContext() {
    return mockCanvasContext;
  }
}

const mockCanvasContext = {
  fillStyle: "",
  font: "",
  globalAlpha: 1,
  lineCap: "round",
  lineJoin: "round",
  lineWidth: 1,
  strokeStyle: "",
  textAlign: "left",
  textBaseline: "alphabetic",
  arc() {},
  beginPath() {},
  clearRect() {},
  closePath() {},
  drawImage() {},
  fill() {},
  fillRect() {},
  fillText() {},
  lineTo() {},
  measureText(text) {
    return { width: String(text).length * 7 };
  },
  moveTo() {},
  rect() {},
  setLineDash() {},
  setTransform() {},
  stroke() {},
  strokeRect() {},
};

class MockImage {
  constructor() {
    this.width = 4261;
    this.height = 6485;
    this.decoding = "auto";
    this._loaded = false;
    this._src = "";
    this._onload = null;
    this.onerror = null;
  }

  set src(value) {
    this._src = value;
    this._loaded = true;
    queueMicrotask(() => {
      if (typeof this._onload === "function") {
        this._onload();
      }
    });
  }

  get src() {
    return this._src;
  }

  set onload(handler) {
    this._onload = handler;
    if (this._loaded && typeof handler === "function") {
      queueMicrotask(() => {
        if (this._onload === handler) {
          handler();
        }
      });
    }
  }

  get onload() {
    return this._onload;
  }
}

export async function runPageLoadSmokeTest() {
  const ids = [
    "map-canvas",
    "toggle-territories",
    "toggle-out-of-bounds-markers",
    "toggle-location-labels",
    "location-icon-size",
    "location-icon-size-value",
    "quest-select",
    "quest-stage-summary",
    "quest-stage-list",
    "marker-legend",
    "legend-toggle-all",
    "clear-quest-selection",
    "mobile-marker-menu-toggle",
    "mobile-quest-menu-toggle",
    "mobile-menu-close",
    "mobile-quest-menu-close",
    "mobile-menu-backdrop",
    "side-menu",
    "quest-menu",
    "mouse-world-coords",
    "reset-view",
    "status",
  ];

  const elements = new Map(ids.map((id) => [`#${id}`, new MockElement(id === "map-canvas" ? "canvas" : "div")]));
  elements.get("#toggle-territories").checked = false;
  elements.get("#toggle-out-of-bounds-markers").checked = false;
  elements.get("#toggle-location-labels").checked = false;
  elements.get("#location-icon-size").value = "18";
  elements.get("#location-icon-size-value").value = "18px";
  elements.get("#status").textContent = "Loading map data...";

  const body = new MockElement("body");
  const document = {
    body,
    activeElement: body,
    querySelector(selector) {
      return elements.get(selector) ?? null;
    },
    createElement(tagName) {
      return new MockElement(tagName);
    },
  };

  const windowObject = {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
    document,
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      };
    },
  };
  const localStorageObject = {
    _store: new Map(),
    getItem(key) {
      return this._store.has(key) ? this._store.get(key) : null;
    },
    setItem(key, value) {
      this._store.set(key, String(value));
    },
  };
  const navigatorObject = {
    clipboard: {
      async writeText() {},
    },
  };
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        updatedAt: new Date(0).toISOString(),
        territoryRaw: {},
        locationRaw: [],
        mapData: {
          points: [],
          paths: [],
          pages: [],
          stats: {
            officialMarkerCount: 0,
            wikiCoordinateCount: 0,
            dedupedPointCount: 0,
            pathCount: 0,
            questPathCount: 0,
          },
        },
      };
    },
  });

  const installGlobal = (key, value) => {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  };

  installGlobal("HTMLElement", MockElement);
  installGlobal("document", document);
  installGlobal("window", windowObject);
  installGlobal("Image", MockImage);
  installGlobal("localStorage", localStorageObject);
  installGlobal("navigator", navigatorObject);
  installGlobal("fetch", fetchImpl);

  windowObject.HTMLElement = MockElement;
  windowObject.Image = MockImage;
  windowObject.localStorage = localStorageObject;
  windowObject.navigator = navigatorObject;
  windowObject.fetch = fetchImpl;

  const moduleUrl = `${pathToFileURL(path.resolve(process.cwd(), "dist/main.js")).href}?smoke=${Date.now()}`;
  await import(moduleUrl);
  await new Promise((resolve) => setTimeout(resolve, 0));

  if (elements.get("#mouse-world-coords").textContent !== "x --, z --") {
    throw new Error("world coordinate readout did not initialize");
  }

  if (!String(elements.get("#status").textContent).includes("Loaded")) {
    throw new Error("status did not reach loaded state");
  }

  return "page load smoke test passed";
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const result = await runPageLoadSmokeTest();
  console.log(result);
}
