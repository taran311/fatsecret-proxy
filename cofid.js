// UK government food tables: McCance and Widdowson's Composition of Foods
// Integrated Dataset (CoFID), about 3,000 everyday foods with lab-measured
// values per 100g. Used for unbranded foods ("150g cooked rice",
// "banana", "red lentils"), where it's more accurate than our US database
// or an AI guess.
//
// The data is data/cofid.json, made from the gov.uk Excel file by
// scripts/import_cofid.py. Searched here by words; the AI then picks the
// right entry (cooked, not raw; the food itself, not a dish with it in).
//
// Contains public sector information licensed under the Open Government
// Licence v3.0.

import { readFileSync } from "node:fs";

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(t) {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(ches|shes|xes|sses|oes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 2 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

// Words that say how much, or join words: not used for matching.
const SKIP = new Set([
  "g", "gram", "grams", "kg", "ml", "l", "of", "a", "an", "the", "x", "and", "with",
  "slice", "can", "tin", "bottle", "pack", "bag", "bar", "cup", "mug", "tbsp", "tsp",
  "serving", "portion", "piece", "scoop", "glass", "pint", "handful", "bowl",
  "small", "medium", "large", "half", "one", "two", "three", "some",
]);

export function words(s) {
  return [...new Set(
    normText(s)
      .split(" ")
      .filter((t) => t && !/^\d/.test(t))
      .map(stem)
      .filter((t) => !SKIP.has(t))
  )];
}

/**
 * Loads the foods from data/cofid.json at [path]; none (so the lookup
 * simply skips this step) if the file isn't there.
 */
export function loadCofid(path) {
  try {
    return createCofid(JSON.parse(readFileSync(path, "utf8")).foods || []);
  } catch (err) {
    console.warn("UK food tables not loaded:", err.message);
    return createCofid([]);
  }
}

export function createCofid(list) {
  const foods = list
    .filter((f) => f && f.name && f.per100)
    .map((f) => ({ ...f, words: new Set(words(f.name)) }));

  /**
   * Up to [limit] entries sharing the most words with [query]: at least
   * half of the query's food words have to be in the entry's name.
   * Shorter names first on a tie. The AI then picks between them.
   */
  function search(query, limit = 8) {
    const q = words(query);
    if (!q.length) return [];
    const scored = [];
    for (const f of foods) {
      let hit = 0;
      for (const w of q) if (f.words.has(w)) hit++;
      const score = hit / q.length;
      if (score >= 0.5) scored.push({ f, score });
    }
    scored.sort((a, b) => b.score - a.score || a.f.words.size - b.f.words.size);
    return scored.slice(0, limit).map((x) => x.f);
  }

  return { size: foods.length, search };
}

/** How an entry reads to the AI that picks between them. */
export function cofidDescription(f) {
  const p = f.per100;
  const r = (x) => Math.round(x * 10) / 10;
  return `Per ${f.per100ml ? "100ml" : "100g"} - Calories: ${Math.round(p.calories)}kcal | ` +
    `Fat: ${r(p.fat)}g | Carbs: ${r(p.carbs)}g | Protein: ${r(p.protein)}g` +
    (f.desc ? ` | ${String(f.desc).slice(0, 120)}` : "");
}
