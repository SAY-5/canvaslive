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
  await page.getByText("Join a room").waitFor();
  await page.getByLabel(/^room$/i).fill(roomId);
  await page.getByLabel(/^name$/i).fill(name);
  await page.getByRole("button", { name: "Enter" }).click();
  // Once joined, the toolbar is visible.
  await page.locator(".toolbar").waitFor();
  await expect(page.locator(".status")).toContainText("connected", { timeout: 10_000 });
}

test("two clients see each other's strokes", async ({ browser }) => {
  const roomId = `e2e_${Date.now().toString(36)}`;

  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  await joinRoom(page1, roomId, "alice");
  await joinRoom(page2, roomId, "bob");

  // Page 1 draws a horizontal stroke in the stage by dragging the pointer.
  const stage = page1.locator(".stage");
  const box = await stage.boundingBox();
  if (!box) throw new Error("no stage box");
  const start = { x: box.x + 100, y: box.y + 100 };
  const end = { x: box.x + 300, y: box.y + 100 };

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

  // Page 2 should see the stroke appear within a short window.
  // We verify by querying the renderer's underlying canvas via window-
  // attached hook, but simpler: check for a non-blank pixel on the
  // main canvas near where alice drew.
  await expect
    .poll(
      async () => {
        return page2.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>("canvas.main");
          if (!canvas) return 0;
          const ctx = canvas.getContext("2d");
          if (!ctx) return 0;
          const { data } = ctx.getImageData(100, 100, 300, 30);
          let nonBg = 0;
          for (let i = 0; i < data.length; i += 4) {
            // Canvas background is #13161d (~19,22,29). Count anything
            // significantly brighter as a drawn pixel.
            if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) > 120) {
              nonBg += 1;
            }
          }
          return nonBg;
        });
      },
      {
        message: "bob should see alice's stroke rendered on canvas",
        timeout: 15_000,
        intervals: [250, 500, 1000],
      },
    )
    .toBeGreaterThan(20);

  // Presence: both clients should show "2 in room" in the status pill.
  await expect(page1.locator(".status")).toContainText("2 in room");
  await expect(page2.locator(".status")).toContainText("2 in room");

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
  await expect(page1.locator(".status")).toContainText("2 in room");

  await ctx2.close();

  await expect(page1.locator(".status")).toContainText("1 in room", {
    timeout: 10_000,
  });

  await ctx1.close();
});
