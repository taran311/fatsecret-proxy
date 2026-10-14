// Saved foods: each food looked up once, then any amount of it worked out
// with arithmetic. "200g tofu", "tofu 150g" and "350 g tofu" are one food
// ("tofu") saved per 100g; "3 hash browns" and "5 hash browns" are one
// food saved per item. Only foods nobody has asked about before need the
// AI or the database.
//
// Kept safe on purpose:
// - The food's name keeps every word except the amount: "plant protein
//   yoghurt" and "protein yoghurt", "light mayo" and "mayo", "cooked rice"
//   and "rice" are different foods. Word order is kept too ("milk
//   chocolate" isn't "chocolate milk").
// - Only amounts we fully understand are worked out here. Anything else
//   ("4oz", "1kg", "a bowl of" a food saved only per 100g) goes to the
//   usual lookup.
// - Nothing is saved unless its numbers add up (see plausible()).
//
// Pure functions only: the Firestore side is in server.js.

const FILLER = new Set(["of", "a", "an", "the", "x"]);

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5,
};

/** Units something can be counted in, by every name people use. */
const UNITS = {
  slice: "slice", slices: "slice",
  can: "can", cans: "can", tin: "can", tins: "can",
  bottle: "bottle", bottles: "bottle",
  pack: "pack", packs: "pack", packet: "pack", packets: "pack",
  bag: "bag", bags: "bag",
  bar: "bar", bars: "bar",
  cup: "cup", cups: "cup", mug: "cup", mugs: "cup",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  serving: "serving", servings: "serving", portion: "serving", portions: "serving",
  piece: "piece", pieces: "piece",
  scoop: "scoop", scoops: "scoop",
  glass: "glass", glasses: "glass",
  pint: "pint", pints: "pint",
  bowl: "bowl", bowls: "bowl",
  handful: "handful", handfuls: "handful",
};

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "crumpets" → "crumpet", "tomatoes" → "tomato", "berries" → "berry". */
function stem(t) {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(ches|shes|xes|sses|oes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 2 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

const isNumber = (t) => /^\d+(?:\.\d+)?$/.test(t);

/**
 * Splits what was typed into the amount and the food:
 * "200g tofu" → { amount: { kind: "g", n: 200 }, key: "tofu" };
 * "3 mccain hash browns" → { amount: { kind: "count", n: 3, unit: null },
 * key: "mccain hash brown" }; "2 slices of white bread" → count 2 of
 * "slice", key "white bread"; "tofu" → { kind: "none" }.
 *
 * Null when the amount isn't one we fully understand (any number left in
 * the food's name, ounces, kilos, two amounts...): the usual lookup
 * handles those.
 */
export function parseFood(text) {
  let tokens = normText(text)
    // "200g" → "200 g", "1.5l" → "1.5 l"
    .replace(/(\d)(g|grams?|ml|l)\b/g, "$1 $2")
    .split(" ")
    .filter(Boolean)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);

  let amount = null;
  const take = (a) => {
    if (amount) return false; // two amounts: not ours to guess
    amount = a;
    return true;
  };

  // A weight or volume anywhere: "200 g", "tofu 150 g", "330 ml", "1.5 l".
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (isNumber(t) && /^(g|gram|grams)$/.test(next || "")) {
      if (!take({ kind: "g", n: Number(t) })) return null;
      i++;
      continue;
    }
    if (isNumber(t) && /^(ml|l)$/.test(next || "")) {
      const n = Number(t) * (next === "l" ? 1000 : 1);
      if (!take({ kind: "ml", n })) return null;
      i++;
      continue;
    }
    out.push(t);
  }
  tokens = out;

  // A count at the start: "3 …", "two …", "half a …", "2 slices of …".
  if (!amount && tokens.length) {
    const first = tokens[0];
    const n = isNumber(first) ? Number(first) : NUMBER_WORDS[first];
    if (n !== undefined && tokens.length > 1) {
      let rest = tokens.slice(1);
      while (rest.length && (rest[0] === "a" || rest[0] === "an" || rest[0] === "x")) {
        rest = rest.slice(1);
      }
      let unit = null;
      if (rest.length > 1 && UNITS[rest[0]]) {
        unit = UNITS[rest[0]];
        rest = rest.slice(1);
        if (rest[0] === "of") rest = rest.slice(1);
      }
      amount = { kind: "count", n, unit };
      tokens = rest;
    }
  }

  const words = tokens.filter((t) => !FILLER.has(t)).map(stem);
  // Any number left ("4oz", "1kg", "2 x 3") is an amount we don't follow.
  if (!words.length || words.some((w) => /\d/.test(w))) return null;
  if (amount && !(amount.n > 0 && amount.n <= (amount.kind === "count" ? 20 : 5000))) {
    return null;
  }
  return { amount: amount || { kind: "none" }, key: words.join(" ") };
}

const r1 = (n) => Math.round(n * 10) / 10;

function values(r, f = 1) {
  return {
    calories: (Number(r.calories) || 0) * f,
    protein: (Number(r.protein) || 0) * f,
    carbs: (Number(r.carbs) || 0) * f,
    fat: (Number(r.fat) || 0) * f,
  };
}

/**
 * Whether a looked-up answer's numbers add up, so it's safe to save and
 * reuse: calories within about a quarter of what the protein, carbs and
 * fat make (4, 4 and 9 kcal a gram); for drinks, more calories than that
 * is fine (alcohol). Per 100g no more than 900 kcal, and no more than
 * 100g of protein, carbs and fat together.
 */
export function plausible(r) {
  const v = values(r);
  const all = [v.calories, v.protein, v.carbs, v.fat];
  if (!all.every((x) => Number.isFinite(x) && x >= 0)) return false;
  const fromMacros = 4 * v.protein + 4 * v.carbs + 9 * v.fat;
  // Next to nothing (black coffee, a diet drink): fine if the macros are too.
  if (v.calories < 5) return fromMacros < 20;
  const slack = Math.max(v.calories * 0.25, 15);
  const drink = !!r.ml && !r.grams;
  if (fromMacros > v.calories + slack) return false;
  if (!drink && fromMacros < v.calories - slack) return false;
  const grams = Number(r.grams);
  if (grams > 0 && !drink) {
    const f = 100 / grams;
    if (v.calories * f > 900) return false;
    if ((v.protein + v.carbs + v.fat) * f > 105) return false;
  }
  return true;
}

/**
 * What a fresh answer teaches about the food, as fields to merge into its
 * saved record: per 100g / 100ml when it has a weight or volume, one item
 * for a plain count ("3 hash browns" → one hash brown), one of a unit
 * ("2 slices"), or the whole answer when no amount was given.
 */
export function learn(parsed, r) {
  if (!parsed || !plausible(r)) return null;
  const fields = {};
  const grams = Number(r.grams) > 0 ? Number(r.grams) : null;
  const ml = Number(r.ml) > 0 ? Number(r.ml) : null;
  const a = parsed.amount;

  if (grams && !ml) fields.per100g = values(r, 100 / grams);
  if (ml) fields.per100ml = values(r, 100 / ml);

  if (a.kind === "count") {
    const one = {
      ...values(r, 1 / a.n),
      grams: grams ? grams / a.n : null,
      ml: ml ? ml / a.n : null,
      // The label for one, when the answer was for exactly one.
      serving: a.n === 1 && r.serving_description ? String(r.serving_description) : null,
    };
    if (a.unit) fields.units = { [a.unit]: one };
    else fields.item = one;
  } else if (a.kind === "none") {
    fields.plain = {
      ...values(r),
      grams,
      ml,
      mode: r.mode || "serving",
      serving: r.serving_description ? String(r.serving_description) : null,
    };
  }
  fields.name = String(r.name || parsed.key);
  fields.source = String(r.source || "");
  fields.confidence = Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : 0.7;
  return fields;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * The answer for [parsed] from a saved food record, or null if the record
 * doesn't cover that kind of amount (a count of a food only saved per
 * 100g, say): then the usual lookup runs.
 */
export function serve(parsed, food, saved) {
  if (!parsed || !saved) return null;
  const a = parsed.amount;
  const base = {
    source: saved.source || "saved",
    name: saved.name || food,
    confidence: Number.isFinite(saved.confidence) ? saved.confidence : 0.7,
    saved: true,
  };
  const out = (v, extra) => ({
    ...base,
    ...extra,
    calories: Math.round(v.calories),
    protein: r1(v.protein),
    carbs: r1(v.carbs),
    fat: r1(v.fat),
  });

  if (a.kind === "g") {
    const p = saved.per100g;
    if (!p) return null;
    return out(values(p, a.n / 100), {
      mode: "weight",
      grams: Math.round(a.n),
      ml: null,
      basis: `saved: ${Math.round(p.calories)} kcal/100g × ${fmt(a.n)}g`,
    });
  }
  if (a.kind === "ml") {
    const p = saved.per100ml;
    if (!p) return null;
    return out(values(p, a.n / 100), {
      mode: "volume",
      grams: null,
      ml: Math.round(a.n),
      basis: `saved: ${Math.round(p.calories)} kcal/100ml × ${fmt(a.n)}ml`,
    });
  }
  if (a.kind === "count") {
    const one = a.unit ? saved.units?.[a.unit] : saved.item;
    if (!one) return null;
    const label = a.unit
      ? a.unit
      : one.serving || (one.grams ? `${Math.round(one.grams)}g` : one.ml ? `${Math.round(one.ml)}ml` : null);
    return out(values(one, a.n), {
      mode: "serving",
      grams: one.grams ? Math.round(one.grams * a.n) : null,
      ml: one.ml ? Math.round(one.ml * a.n) : null,
      serving_description: label ? (a.n === 1 ? label : `${fmt(a.n)} × ${label}`) : null,
      basis: `saved: ${Math.round(one.calories)} kcal each × ${fmt(a.n)}`,
    });
  }
  const p = saved.plain;
  if (!p) return null;
  return out(values(p), {
    mode: p.mode || "serving",
    grams: p.grams ?? null,
    ml: p.ml ?? null,
    ...(p.serving ? { serving_description: p.serving } : {}),
    basis: "saved",
  });
}
