import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const stylesPath = fileURLToPath(new URL("../../apps/web/src/styles.css", import.meta.url));
const sourceStyles = (await readFile(stylesPath, "utf8")).replace('@import "tailwindcss";', "");

test("keeps long Markdown code scrolling inside its block instead of the Timeline", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 720 });
  await page.setContent(`
    <main class="session-pane">
      <div class="timeline-area">
        <div class="timeline-shell">
          <div class="timeline timeline-static" data-testid="timeline">
            <section class="turn-block">
              <article class="agent-message">
                <div class="agent-message-text">
                  <p>原始 DYNBench test400：</p>
                  <pre data-testid="code-block"><code>${"/root/autodl-fs/outputs/FilterGuard/dynbench_clean180_plus220_continuation_review5_20260723/test400_clean180-qwen3-dsv4flash_plus220-lg3-dsv4pro.jsonl".repeat(4)}</code></pre>
                </div>
              </article>
            </section>
          </div>
        </div>
      </div>
    </main>
  `);
  await page.addStyleTag({ content: sourceStyles });

  const overflow = await page.getByTestId("timeline").evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  const codeOverflow = await page.getByTestId("code-block").evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));

  expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  expect(codeOverflow.scrollWidth).toBeGreaterThan(codeOverflow.clientWidth);
});

test("shows Markdown bullets, numbers, and nested indentation after preflight", async ({ page }) => {
  await page.setContent(`
    <article class="agent-message">
      <div class="agent-message-text">
        <ul data-testid="unordered"><li>一级<ul data-testid="nested-unordered"><li>二级<ul data-testid="deep-unordered"><li>三级</li></ul></li></ul></li></ul>
        <ol data-testid="ordered"><li>第一项</li><li>第二项</li></ol>
      </div>
    </article>
  `);
  await page.addStyleTag({ content: sourceStyles });

  const styles = await page.locator("[data-testid]").evaluateAll((nodes) => nodes.map((node) => {
    const computed = getComputedStyle(node);
    return {
      testId: node.getAttribute("data-testid"),
      listStyleType: computed.listStyleType,
      paddingLeft: Math.round(Number.parseFloat(computed.paddingLeft) * 10) / 10,
    };
  }));

  expect(styles).toEqual([
    { testId: "unordered", listStyleType: "disc", paddingLeft: 22.4 },
    { testId: "nested-unordered", listStyleType: "circle", paddingLeft: 20.3 },
    { testId: "deep-unordered", listStyleType: "square", paddingLeft: 20.3 },
    { testId: "ordered", listStyleType: "decimal", paddingLeft: 22.4 },
  ]);
});

test("shows a visible Markdown heading hierarchy after preflight", async ({ page }) => {
  await page.setContent(`
    <article class="agent-message">
      <div class="agent-message-text">
        <h1 data-level="1">一级标题</h1>
        <h2 data-level="2">二级标题</h2>
        <h3 data-level="3">三级标题</h3>
        <h4 data-level="4">四级标题</h4>
        <h5 data-level="5">五级标题</h5>
        <h6 data-level="6">六级标题</h6>
        <p data-testid="paragraph">普通段落</p>
      </div>
    </article>
  `);
  await page.addStyleTag({ content: "h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit;margin:0}" });
  await page.addStyleTag({ content: sourceStyles });

  const headings = await page.locator("[data-level]").evaluateAll((nodes) => nodes.map((node) => {
    const computed = getComputedStyle(node);
    return {
      level: Number(node.getAttribute("data-level")),
      fontSize: Number.parseFloat(computed.fontSize),
      fontWeight: Number.parseInt(computed.fontWeight, 10),
      marginTop: Number.parseFloat(computed.marginTop),
      marginBottom: Number.parseFloat(computed.marginBottom),
    };
  }));
  const paragraphFontSize = await page.getByTestId("paragraph").evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));

  expect(headings.map(({ fontSize }) => fontSize)).toEqual([21, 18, 16, 15, 14, 13]);
  expect(headings.every(({ fontWeight }) => fontWeight >= 680)).toBe(true);
  expect(headings[0]?.marginTop).toBe(0);
  expect(headings.slice(1).every(({ marginTop }) => marginTop > 0)).toBe(true);
  expect(headings.every(({ marginBottom }) => marginBottom > 0)).toBe(true);
  expect(headings[4]?.fontSize).toBe(paragraphFontSize);
});

test("lets the Composer grow with a long prompt but caps it at half the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 720 });
  await page.setContent('<div class="composer"><textarea rows="2"></textarea></div>');
  await page.addStyleTag({ content: sourceStyles });
  const textarea = page.locator(".composer textarea");

  await textarea.fill("short prompt");
  await textarea.evaluate((element) => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight * 0.5)}px`;
  });
  await expect(textarea).toHaveCSS("height", "64px");

  await textarea.fill(Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行 prompt`).join("\n"));
  await textarea.evaluate((element) => {
    element.style.height = "auto";
    const maxHeight = window.innerHeight * 0.5;
    const contentHeight = element.scrollHeight;
    element.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    element.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  });

  const size = await textarea.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    viewportHeight: window.innerHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(size.height).toBe(360);
  expect(size.height).toBe(size.viewportHeight * 0.5);
  expect(size.overflowY).toBe("auto");
  expect(size.scrollHeight).toBeGreaterThan(size.height);
});
