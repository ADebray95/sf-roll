import { expect, test } from "@playwright/test";

test("the committed site loads its graph and routes the default trip", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("fonts.g")) errors.push(m.text());
  });

  await page.goto("/");
  await page.waitForFunction(
    () =>
      window.App && App.family && !App.family.partial && !document.getElementById("result").hidden,
    undefined,
    { timeout: 90_000 },
  );

  const shown = await page.evaluate(() => ({
    routes: App.family.unique.length,
    distance: App.shown.stats.distance_m,
    status: document.getElementById("status").textContent,
  }));
  expect(shown.routes).toBeGreaterThanOrEqual(1);
  expect(shown.distance).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});
