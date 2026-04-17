const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

describe("page load smoke test", () => {
  test("index shows the copy hotkey hint", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");

    expect(html).toContain("Press C to copy cords");
    expect(html).not.toContain('id="mouse-image-coords"');
  });

  test("built app boots without startup errors against the page skeleton", async () => {
    const runnerPath = path.join(__dirname, "page-load-runner.mjs");
    process.chdir(path.join(__dirname, "..", ".."));
    const runnerModule = await import(pathToFileURL(runnerPath).href);
    const output = await runnerModule.runPageLoadSmokeTest();

    expect(output).toContain("page load smoke test passed");
  });
});
