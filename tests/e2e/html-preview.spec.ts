import { test, expect } from "@playwright/test";

const html = `<!doctype html><html><head><style>h1 { color: rgb(20, 80, 120); }</style></head><body>
<h1>HTML preview</h1><button onclick="this.textContent = 'Clicked'">Try interaction</button>
<p id="isolation"></p><p id="network"></p>
<script>
try { parent.document.body.dataset.previewAccess = 'allowed'; } catch { document.querySelector('#isolation').textContent = 'Parent blocked'; }
fetch('/api/preview-must-not-run').then(() => document.querySelector('#network').textContent = 'Allowed').catch(() => document.querySelector('#network').textContent = 'Network blocked');
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.request.get("/api/bootstrap");
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: { csrfToken: "html-preview-test" } }));
  await page.route("**/api/code/directory?*", (route) => route.fulfill({ json: {
    path: "/work", parent: "/", truncated: false,
    entries: ["demo.HTML", "other.htm", "notes.txt"].map((name) => ({ name, path: `/work/${name}`, directory: false })),
  } }));
  await page.route("**/api/code/file?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path")!;
    return route.fulfill({ json: { path, content: path.endsWith(".txt") ? "Plain text" : html, version: "original" } });
  });
  await page.route("**/api/code/file", (route) => route.fulfill({ json: { ...route.request().postDataJSON(), version: "saved" } }));
});

test("renders HTML with working scripts while isolating the host and blocking API calls", async ({ page }) => {
  let apiCalls = 0;
  page.on("request", (request) => { if (request.url().includes("preview-must-not-run")) apiCalls++; });
  await page.goto("/code?root=/work&file=/work/demo.HTML");
  const preview = page.frameLocator('iframe[title="HTML 预览"]');
  await expect(preview.getByRole("heading")).toHaveText("HTML preview");
  await expect(preview.getByRole("heading")).toHaveCSS("color", "rgb(20, 80, 120)");
  await preview.getByRole("button", { name: "Try interaction" }).click();
  await expect(preview.getByRole("button", { name: "Clicked" })).toBeVisible();
  await expect(preview.locator("#isolation")).toHaveText("Parent blocked");
  await expect(preview.locator("#network")).toHaveText("Network blocked");
  expect(apiCalls).toBe(0);
  expect(await page.locator("body").getAttribute("data-preview-access")).toBeNull();
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
});

test("previews unsaved edits, preserves source across toggles, and saves explicitly", async ({ page }) => {
  await page.goto("/code?root=/work&file=/work/demo.HTML");
  await page.getByRole("button", { name: "源码", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "文件内容" });
  await editor.fill("<h1>Unsaved content</h1>");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.frameLocator("iframe").getByRole("heading")).toHaveText("Unsaved content");
  await expect(page.getByRole("status")).toHaveText("未保存");
  await page.getByRole("button", { name: "源码", exact: true }).click();
  await expect(editor).toHaveText("<h1>Unsaved content</h1>");
  await page.getByRole("button", { name: "notes.txt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("未保存的修改");
  await page.getByRole("button", { name: "继续编辑" }).click();
  const saveRequest = page.waitForRequest((request) => request.method() === "PUT");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect((await saveRequest).postDataJSON().content).toBe("<h1>Unsaved content</h1>");
  await expect(page.getByRole("status")).toHaveText("已保存");
  await page.getByRole("button", { name: "notes.txt", exact: true }).click();
  await expect(editor).toHaveText("Plain text");
  await expect(page.getByRole("button", { name: "预览", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "other.htm", exact: true }).click();
  await expect(page.frameLocator("iframe").getByRole("heading")).toHaveText("HTML preview");
});

test("line links open source, and preview controls fit a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/code?root=/work&file=/work/demo.HTML&line=2");
  await expect(page.getByRole("textbox", { name: "文件内容" })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.frameLocator("iframe").getByRole("heading")).toBeVisible();
  const bounds = await page.getByRole("group", { name: "文件视图" }).boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
