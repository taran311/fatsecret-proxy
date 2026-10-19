// Open Food Facts: a free, open database of packaged foods from around the
// world with each product's label values, searched in the person's
// country. Used for branded foods, where our FatSecret plan (US products)
// and the AI (guessing sizes) are weakest.
//
// Their search allows 10 requests a minute from one server, so we keep
// well under that and remember every search: when the minute's allowance
// is used up, the lookup just carries on without it. Each product found
// is saved with the rest of our saved foods, so it's searched once.
//
// Data: Open Food Facts contributors, under the Open Database Licence.

const SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl";
const FIELDS = [
  "code", "product_name", "product_name_en", "brands", "quantity",
  "serving_size", "serving_quantity", "nutriments",
].join(",");

function num(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * One product as we use it: its label values per 100g (or 100ml for a
 * drink) and the weight of one serving, or null if the label doesn't give
 * calories, protein, carbs and fat.
 */
export function offProduct(p) {
  if (!p || typeof p !== "object") return null;
  const n = p.nutriments || {};
  let kcal = num(n["energy-kcal_100g"]);
  if (kcal == null) {
    const kj = num(n["energy-kj_100g"]) ?? num(n.energy_100g);
    if (kj != null) kcal = kj / 4.184;
  }
  const protein = num(n.proteins_100g);
  const carbs = num(n.carbohydrates_100g);
  const fat = num(n.fat_100g);
  if ([kcal, protein, carbs, fat].some((x) => x == null || x < 0)) return null;
  if (kcal > 900 || protein + carbs + fat > 105) return null;

  const name = String(p.product_name_en || p.product_name || "").trim();
  if (!name) return null;
  const brand = String(p.brands || "").split(",")[0].trim();
  const quantity = String(p.quantity || "");
  const serving = num(p.serving_quantity);
  return {
    code: String(p.code || ""),
    name,
    brand,
    // Sold by volume ("330 ml", "1 l"): its per-100 values are per 100ml.
    liquid: /\d\s*(ml|cl|l)\b/i.test(quantity),
    per100: { calories: kcal, protein, carbs, fat },
    servingGrams: serving && serving > 0 && serving < 2000 ? serving : null,
    servingLabel: String(p.serving_size || "").trim() || null,
  };
}

const NOT_PIECES = new Set([
  "g", "gram", "grams", "kg", "ml", "l", "cl", "oz", "serving", "servings", "portion",
  "portions", "pack", "packs", "packet", "box", "bag", "pot", "tub", "jar", "tin", "can",
  "bottle", "tbsp", "tsp", "tablespoon", "teaspoon", "cup", "cups", "scoop", "scoops",
]);
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

const stemWord = (w) => {
  const x = w.replace(/'s$/, "");
  return x.length > 3 && x.endsWith("s") && !x.endsWith("ss") ? x.slice(0, -1) : x;
};
const stems = (text) =>
  String(text || "")
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter(Boolean)
    .map(stemWord);

/**
 * How much one piece of [prod] weighs, from its label's serving when that
 * serving is a number of pieces of the food asked for: "2 hash browns
 * (88 g)" is 44 g a hash brown. So "2 McCain hash browns" is two of the
 * pack's own hash browns, not two of the AI's guess at the size. Null when
 * the serving isn't pieces ("100 g", "1 portion") or not of this food.
 */
export function pieceGrams(prod, food) {
  const label = String(prod?.servingLabel || "").toLowerCase();
  if (!label || prod?.liquid) return null;
  const weight = label.match(/(\d+(?:[.,]\d+)?)\s*g\b/);
  const grams = Number(prod.servingGrams) || (weight ? Number(weight[1].replace(",", ".")) : 0);
  if (!(grams > 0)) return null;
  // The pieces: "2 hash browns", also inside brackets ("88 g (2 hash browns)").
  const text = label.replace(/(\d+(?:[.,]\d+)?)\s*(?:g|grams?|kcal|kj)\b/g, " ");
  const m = text.match(/(?:^|[\s(])(\d+(?:\.\d+)?|one|two|three|four|five|six)\s+([a-z][a-z' -]*[a-z])/);
  if (!m) return null;
  const count = /^\d/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  const item = stems(m[2]).filter((w) => !NOT_PIECES.has(w) && w !== "x");
  if (!(count > 0) || !item.length || NOT_PIECES.has(stems(m[2])[0])) return null;
  // The piece has to be the food asked for: "hash brown" in "mccains
  // hashbrown" (spaces don't matter), or "biscuit" in "3 oreo biscuits".
  const want = stems(food);
  const compact = want.join("");
  const piece = item.join("");
  const shared = item.some((w) => w.length >= 3 && want.includes(w));
  if (!shared && !(piece.length >= 4 && compact.includes(piece))) return null;
  const each = grams / count;
  if (!(each >= 2 && each <= 500)) return null;
  return { grams: each, label: String(prod.servingLabel).trim() };
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** Open Food Facts' name for a country: "GB" → "united-kingdom". */
export function countryTag(cc) {
  let name;
  try {
    name = regionNames.of(String(cc || "GB").toUpperCase());
  } catch {
    name = null;
  }
  return String(name || "United Kingdom")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** How a product reads to the AI that picks between them. */
export function offDescription(prod) {
  const p = prod.per100;
  const unit = prod.liquid ? "100ml" : "100g";
  const r = (x) => Math.round(x * 10) / 10;
  return `Per ${unit} - Calories: ${Math.round(p.calories)}kcal | Fat: ${r(p.fat)}g | ` +
    `Carbs: ${r(p.carbs)}g | Protein: ${r(p.protein)}g` +
    (prod.servingLabel ? ` | Serving: ${prod.servingLabel}` : "");
}

/**
 * The search, kept under Open Food Facts' limit. [get] is axios.get (or a
 * stand-in for tests), [cache] a NodeCache. search() gives the products
 * found, [] for none, or null when it couldn't search right now (over the
 * minute's allowance, or the site didn't answer).
 */
export function createOffSearch({ get, cache, perMinute = 8, userAgent, now = () => Date.now() }) {
  const recent = []; // times of searches in the last minute

  async function search(terms, country = "GB") {
    const q = String(terms || "").trim().toLowerCase();
    if (q.length < 3) return [];
    const tag = countryTag(country);
    const key = `off:${tag}:${q}`;
    const cached = cache?.get(key);
    if (cached) return cached;

    const t = now();
    while (recent.length && t - recent[0] > 60_000) recent.shift();
    if (recent.length >= perMinute) return null;
    recent.push(t);

    try {
      const r = await get(SEARCH_URL, {
        params: {
          search_terms: q,
          search_simple: 1,
          action: "process",
          json: 1,
          page_size: 12,
          fields: FIELDS,
          // Products sold in the person's country.
          tagtype_0: "countries",
          tag_contains_0: "contains",
          tag_0: tag,
        },
        headers: { "User-Agent": userAgent },
        timeout: 8000,
      });
      const products = (Array.isArray(r?.data?.products) ? r.data.products : [])
        .map(offProduct)
        .filter(Boolean);
      cache?.set(key, products, 60 * 60 * 24);
      return products;
    } catch (err) {
      console.warn("Open Food Facts search failed:", err.response?.status || err.message);
      return null;
    }
  }

  return { search };
}
