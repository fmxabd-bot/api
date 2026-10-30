import assert from "node:assert/strict";
import test from "node:test";
import { json } from "./src/router.js";

test("upstream errors hide internal relay details", async () => {
  const response = json({
    code: "UPSTREAM_ERROR",
    message: "MovieBox Railway relay failed",
    upstreamStatus: 403,
  }, 502);
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 502);
  assert.equal(body.code, "UPSTREAM_ERROR");
  assert.equal(body.message, "Movie data is temporarily unavailable. Please try again shortly.");
  assert.equal(body.error, body.message);
  assert.equal("upstreamStatus" in body, false);
  assert.doesNotMatch(serialized, /Railway|relay|403/);
});

test("key-store outages keep their actionable explanation", async () => {
  const response = json({
    code: "KEY_STORE_UNAVAILABLE",
    message: "API key storage is temporarily unavailable.",
  }, 503);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.message, "API key storage is temporarily unavailable.");
});
