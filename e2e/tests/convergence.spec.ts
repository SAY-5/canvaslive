import { test, expect, type Page } from "@playwright/test";

/**
 * End-to-end convergence test: two browser contexts join the same room,
 * one draws, and the other sees the drawing show up.
 *
 * This goes through the real stack: React client → real WebSocket →
 * real server → real SQLite → other client.
 */

async function joinRoom(page: Page, roomId: string, name: string): Promise<void> {
  await page.goto("/");
  await page.locator(".join-card").waitFor();
  await page.getByLabel(/^room$/i).fill(roomId);
  await page.getByLabel(/^name$/i).fill(name);
  await page.getByRole("button", { name: /enter room/i }).click();
  await page.locator(".toolbar").waitFor();
  // The status pill switches from "connecting" → "Room <id>" once the
  // welcome frame lands. Wait for the room-id form as a connect signal.
  await expect(page.locator(".status")).toContainText(/Room /, { timeout: 10_000 });
}

test("two clients see each other's strokes", async ({ browser }) => {
  const roomId = `e2e_${Date.now().toString(36)}`;

  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  await joinRoom(page1, roomId, "alice");
  await joinRoom(page2, roomId, "bob");

  // Alice picks a dark swatch so the stroke contrasts against the cream
  // canvas background (the editorial theme defaults stage color to a
  // warm ~(249,246,240)).
  await page1
    .locator(".palette .palette-swatches button")
    .first()
    .click();

  // Page 1 draws a horizontal stroke in the stage by dragging the pointer.
  const stage = page1.locator(".stage");
  const box = await stage.boundingBox();
  if (!box) throw new Error("no stage box");
  const start = { x: box.x + 150, y: box.y + 150 };
  const end = { x: box.x + 350, y: box.y + 150 };

  await page1.mouse.move(start.x, start.y);
  await page1.mouse.down();
  for (let t = 0; t <= 20; t++) {
    const f = t / 20;
    await page1.mouse.move(
      start.x + (end.x - start.x) * f,
      start.y + (end.y - start.y) * f,
    );
  }
  await page1.mouse.up();

  // Bob should see the stroke land within a short window. We sample a
  // strip of pixels where we drew and count any pixel whose RGB distance
  // from the background exceeds a threshold — robust to background hue
  // changes (cream vs dark) without hard-coding a palette.
  await expect
    .poll(
      async () => {
        return page2.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>("canvas.main");
          if (!canvas) return 0;
          const ctx = canvas.getContext("2d");
          if (!ctx) return 0;
          const { data } = ctx.getImageData(140, 140, 240, 30);
          // Sample the corner pixel as "background" and count all pixels
          // that differ by at least 40 on L1.
          const br = data[0] ?? 0, bg = data[1] ?? 0, bb = data[2] ?? 0;
          let drawn = 0;
          for (let i = 0; i < data.length; i += 4) {
            const dr = Math.abs((data[i] ?? 0) - br);
            const dg = Math.abs((data[i + 1] ?? 0) - bg);
            const db = Math.abs((data[i + 2] ?? 0) - bb);
            if (dr + dg + db > 60) drawn += 1;
          }
          return drawn;
        });
      },
      {
        message: "bob should see alice's stroke rendered on canvas",
        timeout: 15_000,
        intervals: [250, 500, 1000],
      },
    )
    .toBeGreaterThan(20);

  // Presence pill shows a "2 people" count.
  await expect(page1.locator(".status")).toContainText(/2 people/);
  await expect(page2.locator(".status")).toContainText(/2 people/);

  await ctx1.close();
  await ctx2.close();
});

test("peer disconnect removes cursor", async ({ browser }) => {
  const roomId = `e2e_disc_${Date.now().toString(36)}`;
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  await joinRoom(page1, roomId, "alice");
  await joinRoom(page2, roomId, "bob");
  await expect(page1.locator(".status")).toContainText(/2 people/);

  await ctx2.close();

  await expect(page1.locator(".status")).toContainText(/1 person/, {
    timeout: 10_000,
  });

  await ctx1.close();
});
