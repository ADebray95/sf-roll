/* Spec 10.5: the app end to end, at iPhone 13 size, against the built site/. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const MISSION_24TH = { lon: -122.41841, lat: 37.75224 };
/* 24th & Mission to Marina Green at 12%: a trip with several notches */
const TRIP = "#r~12~-~-122.41841~37.75224~-122.44350~37.80600~24th_20_26_20Mission~Marina_20Green";
/* Ferry Building to Coit Tower at 8%: Telegraph Hill makes it infeasible */
const STEEP = "#r~8~-~-122.39380~37.79550~-122.40580~37.80240~Ferry_20Building~Coit_20Tower";

/** Wait until the route on show is final (the Pareto search has finished). */
async function settled(page) {
  await page.waitForFunction(
    () => window.App && App.result && App.result.partial === false,
    undefined,
    { timeout: 60_000 },
  );
}

/** Wait for a loop to be on show. */
async function looped(page) {
  await page.waitForFunction(() => window.App && App.result && App.result.loops, undefined, {
    timeout: 60_000,
  });
}

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("fonts.g")) errors.push(m.text());
  });
  return errors;
}

async function pick(page, field, query) {
  await page.locator("#" + field).fill(query);
  await expect(page.locator(`#${field}_s li`).first()).toBeVisible();
  await page.locator("#" + field).press("Enter");
}

test("1. search a start and a destination: route drawn, summary with comparisons", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await pick(page, "from", "24th & Mission");
  await pick(page, "to", "Dolores Park");
  await settled(page);
  await expect(page.locator("#s_dist")).toHaveText(/^[\d.]+\sk?m \((same|[+−][\d.]+\sk?m)\)$/);
  await expect(page.locator("#s_climb")).toHaveText(/^\d+\sm climb \((same|[+−]\d+\sm)\)$/);
  await expect(page.locator("#s_max")).toHaveText(/^max \d+\s% \(vs \d+\s%\)$/);
  expect(Number(await page.locator("#map").getAttribute("data-route-arcs"))).toBeGreaterThan(5);
  expect(errors).toEqual([]);
});

test("2. lowering the cap changes the route or explains why, and the overlay follows", async ({
  page,
}) => {
  await page.goto(TRIP.replace("r~12~", "r~8~"));
  await settled(page);
  const before = {
    length: await page.locator("#map").getAttribute("data-route-length"),
    overCap: await page.locator("canvas.streets-blocked").getAttribute("data-over-cap"),
  };
  await page.locator("#cap").fill("5");
  await expect(page.locator("#cap_v")).toHaveText(/^Max uphill 5\s%$/);
  await expect(page.locator("#cap")).toHaveAttribute("aria-valuetext", "5 percent");
  await expect(page.locator("canvas.streets-blocked")).toHaveAttribute("data-cap", "5");
  await settled(page);
  const overCap = await page.locator("canvas.streets-blocked").getAttribute("data-over-cap");
  expect(Number(overCap)).toBeGreaterThan(Number(before.overCap));
  const length = await page.locator("#map").getAttribute("data-route-length");
  const banner = await page.locator("#banner").isVisible();
  expect(banner || length !== before.length).toBe(true);
});

test("2b. an infeasible trip names the block and offers the cap that works", async ({ page }) => {
  await page.goto(STEEP);
  await settled(page);
  await expect(page.locator("#banner_t")).toHaveText(
    /^No route stays under 8\s%\. The gentlest route needs \d+\s% on .+\.$/,
  );
  const use = page.locator("#usecap");
  await expect(use).toHaveText(/^Use \d+ %$/);
  await use.click();
  await settled(page);
  await expect(page.locator("#banner")).toBeHidden();
});

test("3. moving the trade-off slider relabels and redraws the route", async ({ page }) => {
  await page.goto(TRIP);
  await settled(page);
  const notch = page.locator("#notch");
  await expect(notch).toBeEnabled();
  await notch.fill("0");
  await expect(page.locator("#notch_v")).toHaveText("Shortest");
  const shortest = await page.locator("#map").getAttribute("data-route-length");
  await notch.fill(await notch.getAttribute("max"));
  await expect(page.locator("#notch_v")).toHaveText(/^\+[\d.]+\sk?m · −\d+\sm climb$/);
  expect(await page.locator("#map").getAttribute("data-route-length")).not.toBe(shortest);
});

test("4. a 3 km loop returns to its start", async ({ page }) => {
  await page.goto(`/#l~8~3~-~0~${MISSION_24TH.lon}~${MISSION_24TH.lat}~24th_20_26_20Mission`);
  await looped(page);
  const loop = await page.evaluate(() => {
    const g = App.graph,
      arcs = App.shown.arcs;
    return {
      closed: g.arcTail(arcs[0]) === g.head[arcs[arcs.length - 1]],
      start: g.arcTail(arcs[0]) === App.state.from.node,
      km: App.shownStats.distance_m / 1000,
    };
  });
  expect(loop.closed && loop.start).toBe(true);
  expect(Math.abs(loop.km - 3)).toBeLessThanOrEqual(0.45);
  await expect(page.locator("#loopbtn")).toHaveAttribute("aria-pressed", "true");
});

test("4b. the loop button turns a trip into a loop", async ({ page }) => {
  await page.goto(TRIP);
  await settled(page);
  await page.locator("#loopbtn").click();
  await expect(page.locator("#looprow")).toBeVisible();
  await expect(page.locator("#loopkm_v")).toHaveText(/^3\skm$/);
  await looped(page);
});

test("5. a saved favourite is listed after a reload", async ({ page }) => {
  await page.goto(TRIP);
  await settled(page);
  await page.locator("#from_star").click();
  await expect(page.locator("#from_star")).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await settled(page);
  await page.locator("#to").focus();
  await page.locator("#to").fill("");
  await page.locator("#to").fill("24th");
  await expect(page.locator("#to_s li", { hasText: "favourite" }).first()).toContainText(
    "24th & Mission",
  );
});

test("6. units switch to feet and miles and stay switched", async ({ page }) => {
  await page.goto(TRIP);
  await settled(page);
  await page.locator("#settingsbtn").click();
  await page.locator("input[value=imperial]").check();
  await page.locator("#settings button.primary").click();
  await expect(page.locator("#s_dist")).toHaveText(/mi/);
  await expect(page.locator("#s_climb")).toHaveText(/ft climb/);
  await page.reload();
  await settled(page);
  await expect(page.locator("#s_dist")).toHaveText(/mi/);
});

test.describe("7. location", () => {
  test.use({
    geolocation: { longitude: MISSION_24TH.lon + 0.0003, latitude: MISSION_24TH.lat },
    permissions: ["geolocation"],
  });
  test("the GPS dot shows and the start is My location", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".gps-dot")).toBeVisible();
    await expect(page.locator("#from")).toHaveValue("My location");
    await expect(page.locator("#recenter")).toBeVisible();
  });
});

test.describe("7b. location denied", () => {
  test.use({ permissions: [] });
  test("says so and falls back to search", async ({ page }) => {
    await page.addInitScript(() => {
      navigator.geolocation.watchPosition = (_ok, fail) => {
        setTimeout(() => fail({ code: 1, message: "denied" }), 50);
        return 1;
      };
    });
    await page.goto("/");
    await expect(page.locator("#status")).toHaveText(/Location access is off/);
    await expect(page.locator("#from")).toHaveValue("");
  });
});

test("9. a shared link reproduces the same route", async ({ page, browser }) => {
  await page.goto(TRIP);
  await settled(page);
  await page.locator("#notch").fill("2");
  const url = page.url();
  const route = await page.evaluate(() => App.shown.arcs.join(","));
  const other = await browser.newPage();
  await other.goto(url);
  await settled(other);
  expect(await other.evaluate(() => App.shown.arcs.join(","))).toBe(route);
  await other.close();
});

test("10. no serious or critical accessibility issues", async ({ page }) => {
  await page.goto(TRIP);
  await settled(page);
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => v.id + ": " + v.nodes.map((n) => n.target).join(" "))).toEqual([]);
});

test("8. after one visit the app loads and routes offline, from the service worker", async ({
  page,
  context,
}) => {
  await page.goto(TRIP);
  await settled(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => {
    const keys = await caches.keys();
    for (const k of keys) {
      const c = await caches.open(k);
      if ((await c.keys()).some((r) => r.url.includes("/data/graph-"))) return true;
    }
    return false;
  });
  const fromWorker = [];
  page.on("response", (r) => {
    if (r.fromServiceWorker()) fromWorker.push(r.url());
  });
  await context.setOffline(true);
  await page.reload();
  await settled(page);
  expect(Number(await page.locator("#map").getAttribute("data-route-arcs"))).toBeGreaterThan(5);
  expect(fromWorker.some((u) => u.includes("/data/graph-"))).toBe(true);
  // and a new route, computed offline
  await page.locator("#cap").fill("6");
  await page.locator("#cap").dispatchEvent("change");
  await settled(page);
  await context.setOffline(false);
});
