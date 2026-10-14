// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFood, plausible, learn, serve } from "../food_base.js";

test("the amount comes off, every other word stays", () => {
  assert.deepEqual(parseFood("200g tofu"), { amount: { kind: "g", n: 200 }, key: "tofu" });
  assert.deepEqual(parseFood("Tofu 150 g"), { amount: { kind: "g", n: 150 }, key: "tofu" });
  assert.deepEqual(parseFood("3 McCain hash browns"),
    { amount: { kind: "count", n: 3, unit: null }, key: "mccain hash brown" });
  assert.deepEqual(parseFood("2 slices of white bread"),
    { amount: { kind: "count", n: 2, unit: "slice" }, key: "white bread" });
  assert.deepEqual(parseFood("half an avocado"),
    { amount: { kind: "count", n: 0.5, unit: null }, key: "avocado" });
  assert.deepEqual(parseFood("330ml oat milk"), { amount: { kind: "ml", n: 330 }, key: "oat milk" });
  assert.deepEqual(parseFood("1.5l water"), { amount: { kind: "ml", n: 1500 }, key: "water" });
  assert.deepEqual(parseFood("tofu"), { amount: { kind: "none" }, key: "tofu" });
});

test("describing words keep foods apart", () => {
  const key = (t) => parseFood(t).key;
  assert.notEqual(key("200g Alpro plant protein yoghurt"), key("200g Alpro protein yoghurt"));
  assert.notEqual(key("light mayo 15g"), key("mayo 15g"));
  assert.notEqual(key("100g cooked rice"), key("100g rice"));
  assert.notEqual(key("milk chocolate 30g"), key("chocolate milk 30g"));
  assert.notEqual(key("1 large egg"), key("1 egg"));
  assert.equal(key("200g Alpro plant protein yoghurt"), key("Alpro Plant Protein Yoghurt 150g"));
});

test("amounts we don't follow go to the usual lookup", () => {
  assert.equal(parseFood("4oz tofu"), null);
  assert.equal(parseFood("1kg rice"), null);
  assert.equal(parseFood("200g tofu 100g rice"), null);
  assert.equal(parseFood("tofu 2"), null);
  assert.equal(parseFood("30 almonds"), null, "counts over 20");
  assert.equal(parseFood("200g"), null);
});

test("numbers that don't add up are never saved", () => {
  // 162 kcal pot: fine.
  assert.ok(plausible({ calories: 162, protein: 15, carbs: 14, fat: 4.4, grams: 200 }));
  // Calories that don't match the macros.
  assert.ok(!plausible({ calories: 600, protein: 15, carbs: 14, fat: 4.4, grams: 200 }));
  assert.ok(!plausible({ calories: 50, protein: 15, carbs: 14, fat: 4.4, grams: 200 }));
  // More than 900 kcal per 100g.
  assert.ok(!plausible({ calories: 1000, protein: 0, carbs: 0, fat: 111, grams: 100 }));
  // Beer: alcohol makes calories with no macros, fine for a drink.
  assert.ok(plausible({ calories: 215, protein: 1.7, carbs: 18, fat: 0, ml: 568 }));
  // Black coffee.
  assert.ok(plausible({ calories: 2, protein: 0.3, carbs: 0, fat: 0, ml: 250 }));
});

test("learn once, then any amount is arithmetic", () => {
  const tofu = learn(parseFood("200g tofu"),
    { source: "ai", name: "Tofu", calories: 240, protein: 26, carbs: 2, fat: 14, grams: 200, mode: "weight" });
  assert.equal(tofu.per100g.calories, 120);
  const r = serve(parseFood("tofu 350g"), "tofu 350g", tofu);
  assert.equal(r.calories, 420);
  assert.equal(r.grams, 350);
  assert.equal(r.protein, 45.5);
  // A count of it isn't known yet: the usual lookup.
  assert.equal(serve(parseFood("2 tofu"), "2 tofu", tofu), null);
});

test("counted foods are saved per item", () => {
  const hb = learn(parseFood("3 mccain hash browns"),
    { source: "web", name: "McCain Hash Browns", calories: 240, protein: 3.1, carbs: 31, fat: 11, grams: 118 });
  assert.equal(Math.round(hb.item.calories), 80);
  const five = serve(parseFood("5 McCain hash browns"), "5 McCain hash browns", hb);
  assert.equal(five.calories, 400);
  assert.equal(five.grams, 197);
  assert.match(five.serving_description, /^5 × /);
  // And per 100g, from the weight.
  assert.equal(serve(parseFood("100g mccain hash browns"), "x", hb).calories, 203);
});

test("units are their own thing", () => {
  const bread = learn(parseFood("2 slices of white bread"),
    { source: "fatsecret", name: "White Bread", calories: 170, protein: 6, carbs: 32, fat: 1.4 });
  assert.equal(serve(parseFood("3 slices white bread"), "x", bread).calories, 255);
  assert.equal(serve(parseFood("3 white bread"), "x", bread), null);
});

test("an implausible answer teaches nothing", () => {
  assert.equal(learn(parseFood("200g tofu"), { calories: 900, protein: 1, carbs: 1, fat: 1, grams: 200 }), null);
});
