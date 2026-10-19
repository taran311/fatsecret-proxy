// Reading recipes from screenshots: cleaning the AI's answer and checking
// the images sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanImport, readImages, MAX_LINES } from "../recipe_import.js";

test("keeps ingredient lines, trims and de-duplicates them", () => {
  const r = cleanImport({
    title: "  Green   curry ",
    servings: "4",
    ingredients: [
      { query: "1000ml coconut milk", as_written: "coco 1,000.0 ml", shown_kcal: 140, unclear: true },
      { query: "1188g tofu", as_written: "tofu 1,188.0 gram", shown_kcal: "1,402" },
      { query: "1188g Tofu", shown_kcal: 1402 }, // same line again (second screenshot)
      { query: "   " },
      { query: "250" }, // no food name
      "not an object",
      { query: "3 medium red onion", shown_kcal: null },
    ],
  });
  assert.equal(r.title, "Green curry");
  assert.equal(r.servings, 4);
  assert.deepEqual(
    r.ingredients.map((i) => i.query),
    ["1000ml coconut milk", "1188g tofu", "3 medium red onion"]
  );
  assert.equal(r.ingredients[0].unclear, true);
  assert.equal(r.ingredients[0].asWritten, "coco 1,000.0 ml");
  assert.equal(r.ingredients[1].shownKcal, 1402);
  assert.equal(r.ingredients[1].unclear, false);
  assert.equal(r.ingredients[2].shownKcal, null);
  assert.equal(r.ingredients[2].asWritten, "3 medium red onion");
});

test("nonsense numbers are dropped, and nothing comes back for junk", () => {
  const r = cleanImport({
    servings: 0,
    ingredients: [{ query: "100g oats", shown_kcal: -5 }, { query: "1 banana", shown_kcal: 99999 }],
  });
  assert.equal(r.servings, null);
  assert.equal(r.ingredients[0].shownKcal, null);
  assert.equal(r.ingredients[1].shownKcal, null);
  assert.deepEqual(cleanImport(null), { title: "", servings: null, ingredients: [] });
  const many = cleanImport({
    ingredients: Array.from({ length: 60 }, (_, i) => ({ query: `${i + 1}g food ${i}` })),
  });
  assert.equal(many.ingredients.length, MAX_LINES);
});

test("images: at least one, at most three, known types, not too big", () => {
  assert.ok(readImages({}).error);
  assert.ok(readImages({ images: [{ image: "abc", mime: "image/png" }] }).images);
  assert.ok(readImages({ images: Array(4).fill({ image: "a" }) }).error);
  assert.ok(readImages({ images: [{ image: "a", mime: "application/pdf" }] }).error);
  assert.ok(readImages({ images: [{ image: "" }] }).error);
  assert.ok(readImages({ images: [{ image: "x".repeat(20) }] }, { maxTotalChars: 10 }).error);
});
