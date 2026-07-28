import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const stylesPath = fileURLToPath(new URL("../../apps/web/src/styles.css", import.meta.url));

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
  await page.addStyleTag({ path: stylesPath });

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
