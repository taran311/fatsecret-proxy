// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { offProduct, createOffSearch } from "../off.js";
import { createCofid, words } from "../cofid.js";

// Stands in for NodeCache.
function memoryCache() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
}

const alpro = {
  code: "5411188134985",
  product_name: "Plant Protein Red Fruits",
  brands: "Alpro, Danone",
  quantity: "200 g",
  serving_size: "200 g",
  serving_quantity: 200,
  nutriments: { "energy-kcal_100g": 81, proteins_100g: 7.5, carbohydrates_100g: 7, fat_100g: 2.2 },
};

test("Open Food Facts product: label values per 100g", () => {
  const p = offProduct(alpro);
  assert.equal(p.brand, "Alpro");
  assert.equal(p.per100.calories, 81);
  assert.equal(p.servingGrams, 200);
  assert.equal(p.liquid, false);
  // kJ only: converted.
  const kj = offProduct({ ...alpro, nutriments: { "energy-kj_100g": 339, proteins_100g: 7.5, carbohydrates_100g: 7, fat_100g: 2.2 } });
  assert.equal(Math.round(kj.per100.calories), 81);
  // Missing macros, or impossible values: not used.
  assert.equal(offProduct({ ...alpro, nutriments: { "energy-kcal_100g": 81 } }), null);
  assert.equal(offProduct({ ...alpro, nutriments: { "energy-kcal_100g": 1200, proteins_100g: 1, carbohydrates_100g: 1, fat_100g: 1 } }), null);
  assert.equal(offProduct({ ...alpro, quantity: "1 l" }).liquid, true);
});

test("Open Food Facts search stays under the limit and remembers", async () => {
  let calls = 0;
  let t = 0;
  const off = createOffSearch({
    get: async () => { calls++; return { data: { products: [alpro] } }; },
    cache: memoryCache(),
    perMinute: 2,
    userAgent: "test",
    now: () => t,
  });
  assert.equal((await off.search("alpro protein")).length, 1);
  assert.equal((await off.search("alpro protein")).length, 1, "remembered");
  assert.equal(calls, 1);
  await off.search("oatly");
  assert.equal(await off.search("tofoo"), null, "over the minute's allowance");
  t = 61_000;
  assert.ok(Array.isArray(await off.search("tofoo")), "a minute later it searches again");
  assert.equal(calls, 3);
});

test("UK food tables: found by words (the AI then picks)", () => {
  const tables = createCofid([
    { name: "Banana cake", per100: { calories: 340, protein: 5, carbs: 50, fat: 15 } },
    { name: "Bananas, flesh only", per100: { calories: 81, protein: 1.1, carbs: 20.3, fat: 0.1 } },
    { name: "Rice, white, basmati, boiled in unsalted water", per100: { calories: 136, protein: 2.9, carbs: 31, fat: 0.4 } },
    { name: "Rice, white, basmati, raw", per100: { calories: 360, protein: 8, carbs: 80, fat: 1 } },
  ]);
  assert.deepEqual(tables.search("1 banana").map((f) => f.name).sort(),
    ["Banana cake", "Bananas, flesh only"]);
  const rice = tables.search("150g boiled basmati rice").map((f) => f.name);
  assert.equal(rice[0], "Rice, white, basmati, boiled in unsalted water");
  assert.deepEqual(tables.search("tofu"), []);
  assert.deepEqual(words("2 slices of white bread"), ["white", "bread"]);
});
