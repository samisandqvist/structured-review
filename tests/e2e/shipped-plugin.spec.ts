import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createShippedReview, type ShippedReview } from "../fixtures/shipped-review.js";

type SessionCreate = { sessionId: string; uiUrl: string; changedNodes: number; indexWarnings: string[] };
type ReviewStatus = {
  sessionId: string;
  coverage: { changedTotal: number; covered: number; unassigned: number };
  units: { reviewed: number; total: number }[];
  unreviewed: { stableId: string }[];
};
type Exported = {
  comments: Array<{
    text: string;
    anchor?: { startLine: number; startSide: string; endLine: number; endSide: string };
    reviewStatus?: string;
  }>;
};

let review: ShippedReview;
let session: SessionCreate;

test.beforeAll(async () => {
  review = await createShippedReview();
  await review.start();
  session = await review.crw<SessionCreate>("session", "create", "--branch", "HEAD", "--base", "HEAD");
  expect(session.changedNodes).toBeGreaterThan(0);
  expect(session.indexWarnings).toEqual([]);
  const context = await review.crw<{ flows: unknown[]; changes: unknown[] }>(
    "context",
    "--session",
    session.sessionId,
    "--brief",
  );
  expect(context.changes.length).toBeGreaterThan(0);
  await review.crw("plan", "--session", session.sessionId, "--auto");
});

test.afterAll(async () => {
  await review?.cleanup();
});

async function selectFirstChangedNode(page: Page): Promise<void> {
  await page.goto(session.uiUrl);
  await expect(page.getByText("Plan", { exact: true })).toBeVisible();
  await page.keyboard.press("j");
  await expect(page.locator('tr[data-line-type="added"]').first()).toBeVisible();
}

async function reselectPersistedComment(page: Page): Promise<void> {
  await expect(page.getByText("Plan", { exact: true })).toBeVisible();
  const commentedStep = page.locator("button.step--reviewed").first();
  await expect(commentedStep).toBeVisible();
  await commentedStep.click();
}

async function expectComment(page: Page, text: string): Promise<void> {
  const comments = page.getByRole("heading", { name: "Comments" }).locator("../..");
  await expect(comments).toContainText(text, { timeout: 30_000 });
}

test("shipped CLI, server, and UI preserve an anchored comment through edit and restart", async ({ page }) => {
  await selectFirstChangedNode(page);

  await page.keyboard.press("?");
  await expect(page.getByText("next / previous change")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("next / previous change")).toBeHidden();

  await page.locator('tr[data-line-type="added"]').first().click();
  const anchorChip = page.getByText(/^commenting on /);
  await expect(anchorChip).toBeVisible();
  const originalAnchor = await anchorChip.textContent();

  await page.keyboard.press("c");
  const input = page.getByTestId("comment-input");
  await expect(input).toBeFocused();
  await input.fill("Quantity should reject negative values");
  await input.press("Control+Enter");
  await expect(page.getByText("Quantity should reject negative values", { exact: true })).toBeVisible();

  const savedAnchor = page.getByRole("button", { name: originalAnchor?.replace("commenting on ", "") ?? "" });
  await expect(savedAnchor).toHaveScreenshot("anchored-comment-chip.png");

  await page.getByRole("button", { name: "edit comment" }).click();
  const edit = page.getByRole("textbox", { name: "edit comment text" });
  await edit.fill("Quantity must reject negative values before pricing");
  await edit.press("Control+Enter");
  await expectComment(page, "Quantity must reject negative values before pricing");
  await expect(savedAnchor).toBeVisible();

  await page.reload();
  await reselectPersistedComment(page);
  await expectComment(page, "Quantity must reject negative values before pricing");

  await review.stop();
  await expect.poll(async () => (await review.databaseFiles()).length).toBe(1);
  await expect(access(join(review.repo, "review.db"))).rejects.toThrow();
  await review.start();
  await page.reload();
  await reselectPersistedComment(page);
  await expectComment(page, "Quantity must reject negative values before pricing");

  const exported = await review.crw<Exported>("comments", "--session", session.sessionId);
  expect(exported.comments).toHaveLength(1);
  expect(exported.comments[0]).toMatchObject({
    text: "Quantity must reject negative values before pricing",
    reviewStatus: "reviewed-commented",
    anchor: { startSide: "new", endSide: "new" },
  });

  await page.getByRole("button", { name: "delete comment" }).click();
  await expect(page.getByText("Quantity must reject negative values before pricing", { exact: true })).toBeHidden();
  await expect(page.getByText("reviewed", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await review.crw<Exported>("comments", "--session", session.sessionId)).comments.length)
    .toBe(0);
  const status = await review.crw<ReviewStatus>("status", "--session", session.sessionId);
  expect(status.units.reduce((sum, unit) => sum + unit.reviewed, 0)).toBe(1);
  expect(status.unreviewed).toHaveLength(status.coverage.changedTotal - 1);

  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
});

test("shipped CLI rejects invalid bases and refuses a hub for a different repository", async () => {
  const invalidBase = await review.crwFailure("session", "create", "--branch", "HEAD", "--base", "missing-base-ref");
  expect(invalidBase.code).not.toBe(0);
  expect(invalidBase.stderr).toContain("missing-base-ref");

  let wrongRepo: { code?: number; stderr?: string } | undefined;
  try {
    await review.crwFrom(review.otherRepo, "serve", "--repo", review.otherRepo);
  } catch (error) {
    wrongRepo = error as { code?: number; stderr?: string };
  }
  expect(wrongRepo?.code).not.toBe(0);
  expect(wrongRepo?.stderr).toContain("port is occupied by a hub serving");
  expect(wrongRepo?.stderr).toContain(review.repo);
});
