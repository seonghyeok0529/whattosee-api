import test from "node:test";
import assert from "node:assert/strict";
import { classifyWithRetry, shouldUseFrameGroupCache } from "./issueFrameGroups.js";

test("cache hit/miss + force=true", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const future = new Date("2026-01-01T01:00:00.000Z");
  const past = new Date("2025-12-31T23:00:00.000Z");

  assert.equal(
    shouldUseFrameGroupCache({ force: false, expiresAt: future, now }),
    true
  );
  assert.equal(
    shouldUseFrameGroupCache({ force: false, expiresAt: past, now }),
    false
  );
  assert.equal(
    shouldUseFrameGroupCache({ force: true, expiresAt: future, now }),
    false
  );
});

test("JSON 파싱 실패 시 재시도 후 성공", async () => {
  let called = 0;
  const result = await classifyWithRetry(async () => {
    called += 1;
    if (called < 3) return "not-json";
    return JSON.stringify({
      groups: { A: [{ id: "a1" }], B: [{ id: "b1" }] },
      rationale: { A: "ra", B: "rb" },
    });
  }, "prompt", 3);

  assert.equal(result.attempts, 3);
  assert.ok(result.parsed);
  assert.equal(result.parsed?.groups.A[0]?.id, "a1");
});
