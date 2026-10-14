// Open Food Facts: a free, open database of packaged foods with each
// product's label values, with strong UK coverage. Used for branded foods,
// where our FatSecret plan (US products) and the AI (guessing sizes) are
// weakest.
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

  async function search(terms) {
    const q = String(terms || "").trim().toLowerCase();
    if (q.length < 3) return [];
    const key = `off:${q}`;
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
          // Products sold in the UK.
          tagtype_0: "countries",
          tag_contains_0: "contains",
          tag_0: "united-kingdom",
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
