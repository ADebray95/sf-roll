/* Spec 10.4: performance under 4x CPU throttling (the proxy for a mid-range phone). */
import { expect, test } from "@playwright/test";

const SCENARIOS = [
  // [from lon, lat, to lon, lat, cap %]
  [-122.41036, 37.79982, -122.41709, 37.80008, 8], // Filbert, Leavenworth to Hyde
  [-122.42795, 37.75528, -122.43346, 37.75494, 8], // 22nd, Church to Vicksburg
  [-122.3938, 37.7955, -122.4058, 37.8024, 8], // Ferry Building to Coit Tower
  [-122.4075, 37.788, -122.4103, 37.7924, 8], // Union Square to the Fairmont
  [-122.4142, 37.7793, -122.4347, 37.7762, 8], // Civic Center to Alamo Square
  [-122.4351, 37.7626, -122.428, 37.758, 8], // Castro & Market to Church & 20th
  [-122.4184, 37.7522, -122.4351, 37.7516, 8], // Mission & 24th to Castro & 24th
  [-122.3962, 37.7937, -122.4435, 37.806, 5], // Embarcadero & Market to Marina Green
  [-122.4148, 37.7588, -122.4026, 37.7835, 8], // Folsom & 20th to Mission & 5th
  [-122.41841, 37.75224, -122.4435, 37.806, 12], // 24th & Mission to Marina Green
];

function p95(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

test.describe.configure({ mode: "serial" });

test("graph decode, routing and loops are fast enough on a throttled CPU", async ({ page }) => {
  test.setTimeout(300_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto("/");
  await page.waitForFunction(() => performance.getEntriesByName("rollsf:ready").length, undefined, {
    timeout: 60_000,
  });
  // from navigation start to the app's own ready-to-route mark: page, scripts, graph decode
  const ready = await page.evaluate(
    () => performance.getEntriesByName("rollsf:ready")[0].startTime,
  );

  const times = await page.evaluate((scenarios) => {
    const out = { routes: [], loops: [] };
    const g = App.graph;
    for (const [lon1, lat1, lon2, lat2, cap] of scenarios) {
      const a = App.pointAt(lon1, lat1, "a"),
        b = App.pointAt(lon2, lat2, "b");
      const t = performance.now();
      let tr = g.tradeoff(a.node, b.node, cap / 100);
      if (!tr) tr = g.tradeoff(a.node, b.node, g.minimaxCap(a.node, b.node));
      while (!tr.search.step(1e9));
      tr.notches();
      out.routes.push(performance.now() - t);
    }
    for (const [lon, lat] of scenarios.slice(0, 5)) {
      const a = App.pointAt(lon, lat, "a");
      const t = performance.now();
      const s = g.loops(a.node, { targetM: 3000, cap: 0.08 });
      while (!s.step(1e9));
      out.loops.push(performance.now() - t);
    }
    return out;
  }, SCENARIOS);
  console.log(
    JSON.stringify({
      ready,
      routeP95: p95(times.routes),
      routes: times.routes.map(Math.round),
      loopP95: p95(times.loops),
      loops: times.loops.map(Math.round),
    }),
  );
  expect(ready).toBeLessThan(2_000); // page, script and graph decode, to ready-to-route
  expect(p95(times.routes)).toBeLessThan(500);
  expect(p95(times.loops)).toBeLessThan(2_000);
});

/* Drag the cap slider from one fraction of its width to another. */
async function drag(page, from, to) {
  const box = await page.locator("#cap").boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) {
    await page.mouse.move(box.x + box.width * (from + ((to - from) * i) / 20), y);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
}

test("dragging the cap slider causes no long tasks", async ({ page }) => {
  test.setTimeout(120_000);
  const cdp = await page.context().newCDPSession(page);
  await page.goto("/#r~8~-~-122.41841~37.75224~-122.4435~37.806~a~b");
  await page.waitForFunction(() => window.App && App.result && App.result.partial === false);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  // Headless Chromium spends ~280 ms compositing the page's first pointer
  // drag, even with every handler of the app switched off; one warm-up drag
  // takes that cost, so what is measured is the app's own work.
  await drag(page, 0.3, 0.35);
  await page.waitForFunction(() => App.result && App.result.partial === false);
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__long.push(Math.round(e.duration));
    }).observe({ type: "longtask" });
  });
  await drag(page, 0.35, 0.75);
  await page.waitForTimeout(500);
  const long = await page.evaluate(() => window.__long);
  console.log(JSON.stringify({ longTasks: long }));
  expect(long.filter((d) => d > 100)).toEqual([]);
});

test("first load transfers at most 6 MB", async ({ page }) => {
  let bytes = 0;
  page.on("response", async (r) => {
    const len = Number(r.headers()["content-length"] || 0);
    bytes += len || (await r.body().catch(() => Buffer.alloc(0))).length;
  });
  await page.goto("/");
  await page.waitForFunction(() => window.App && App.graph, undefined, { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  console.log(JSON.stringify({ mb: +(bytes / 1e6).toFixed(2) }));
  expect(bytes).toBeLessThan(6e6);
});
