import { expect, test } from "@playwright/test";

const TRIP = "#t~-122.41841~37.75224~-122.42809~37.76143~1.000~24th_20_26_20Mission~Dolores_20Park";

test("the site loads its graph and routes a shared trip", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("fonts.g")) errors.push(m.text());
  });

  await page.goto("/" + TRIP);
  await page.waitForFunction(
    () =>
      window.App && App.family && !App.family.partial && !document.getElementById("result").hidden,
    undefined,
    { timeout: 90_000 },
  );

  const shown = await page.evaluate(() => ({
    routes: App.family.unique.length,
    distance: App.shown.stats.distance_m,
    steepest: App.shown.stats.steepest,
  }));
  expect(shown.routes).toBeGreaterThanOrEqual(1);
  expect(shown.distance).toBeGreaterThan(500);
  expect(shown.steepest).toBeGreaterThanOrEqual(0);
  expect(errors).toEqual([]);
});
