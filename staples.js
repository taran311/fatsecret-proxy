// UK staples with label values, checked before the AI. The AI is close on
// most foods but a little off on a few everyday ones (crumpets, plant
// milks), and these are the foods people log most, so they're worth
// getting exactly right. Values are per 100g (or per 100ml for drinks)
// from UK packs; check any you change against the pack.
//
// names: what people type (amounts and plurals are ignored when matching).
// item: grams (or ml) of one ("1 crumpet", "1 slice"); serving: the
// amount used when nothing's said ("crumpets" = 1 crumpet,
// "soya milk" = a 200ml glass).

export const STAPLES = [
  {
    label: "Crumpet (Warburtons)",
    names: ["crumpet", "warburtons crumpet"],
    per100: { kcal: 160, protein: 5.5, carbs: 31.5, fat: 0.7 },
    item: 55, itemLabel: "crumpet",
  },
  {
    label: "Unsweetened soya milk (Alpro)",
    names: ["unsweetened soya milk", "unsweetened soy milk", "soya milk unsweetened",
      "alpro unsweetened soya", "alpro soya unsweetened", "alpro no sugars soya"],
    drink: true,
    per100: { kcal: 33, protein: 3.3, carbs: 0, fat: 1.8 },
    serving: 200,
  },
  {
    label: "Semi-skimmed milk",
    names: ["semi skimmed milk", "semi-skimmed milk", "semi skimmed", "semi-skimmed"],
    drink: true,
    per100: { kcal: 50, protein: 3.6, carbs: 4.8, fat: 1.8 },
    serving: 200,
  },
  {
    label: "Skimmed milk",
    names: ["skimmed milk", "skim milk"],
    drink: true,
    per100: { kcal: 35, protein: 3.5, carbs: 5.0, fat: 0.1 },
    serving: 200,
  },
  {
    label: "Whole milk",
    names: ["whole milk", "full fat milk"],
    drink: true,
    per100: { kcal: 64, protein: 3.4, carbs: 4.7, fat: 3.6 },
    serving: 200,
  },
  {
    label: "Egg",
    names: ["egg", "eggs", "boiled egg", "poached egg"],
    per100: { kcal: 131, protein: 12.6, carbs: 0.2, fat: 9.0 },
    // Eaten weight (no shell) by UK size.
    item: 50, sizes: { small: 43, medium: 50, large: 58, "very large": 66 },
    itemLabel: "egg",
  },
  {
    label: "White bread",
    names: ["white bread", "white toast"],
    per100: { kcal: 235, protein: 8.4, carbs: 45.5, fat: 1.9 },
    item: 36, itemLabel: "medium slice",
  },
  {
    label: "Wholemeal bread",
    names: ["wholemeal bread", "wholemeal toast", "brown bread", "brown toast"],
    per100: { kcal: 228, protein: 10.0, carbs: 39.0, fat: 2.5 },
    item: 40, itemLabel: "medium slice",
  },
  {
    label: "Weetabix",
    names: ["weetabix", "weetabix original"],
    per100: { kcal: 362, protein: 12.0, carbs: 69.0, fat: 2.0 },
    item: 18.75, itemLabel: "biscuit",
  },
  {
    label: "Porridge oats",
    names: ["porridge oats", "rolled oats", "oats"],
    per100: { kcal: 374, protein: 11.0, carbs: 60.0, fat: 8.0 },
    item: 40, itemLabel: "bowl (40g)",
  },
  {
    label: "Baked beans (Heinz)",
    names: ["baked beans", "heinz baked beans", "beanz"],
    per100: { kcal: 78, protein: 4.7, carbs: 12.5, fat: 0.2 },
    item: 207, itemLabel: "half can",
  },
];

/** Millilitres in a named drink amount. */
export const DRINK_UNITS = { pint: 568, glass: 200, cup: 250, mug: 300, can: 330, bottle: 500 };
