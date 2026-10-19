// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { pieceGrams } from "../off.js";

const prod = (servingLabel, servingGrams = null, liquid = false) => ({
  servingLabel,
  servingGrams,
  liquid,
});

test("a serving of several pieces gives one piece's weight", () => {
  assert.equal(pieceGrams(prod("2 hash browns (88 g)", 88), "1 mccains hashbrown").grams, 44);
  assert.equal(pieceGrams(prod("2 hash browns (88g)"), "2 McCain hash browns").grams, 44);
  assert.equal(pieceGrams(prod("88 g (2 hash browns)"), "1 mccain hash brown").grams, 44);
  assert.equal(pieceGrams(prod("3 biscuits (34g)", 34), "2 oreo biscuits").grams.toFixed(1), "11.3");
  assert.equal(pieceGrams(prod("1 bar (35 g)", 35), "1 yubi bar").grams, 35);
});

test("not pieces, or not this food: null", () => {
  assert.equal(pieceGrams(prod("100 g", 100), "2 mccain hash browns"), null);
  assert.equal(pieceGrams(prod("1 portion (100g)", 100), "2 mccain hash browns"), null);
  assert.equal(pieceGrams(prod("2 slices (72g)", 72), "2 mccain hash browns"), null);
  assert.equal(pieceGrams(prod("1 x 44g", 44), "2 mccain hash browns"), null);
  assert.equal(pieceGrams(prod(""), "2 mccain hash browns"), null);
  assert.equal(pieceGrams(prod("1 bottle (330 ml)", null, true), "1 bottle"), null);
});
