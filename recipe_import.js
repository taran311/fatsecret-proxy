// Reading a recipe from screenshots or photos: another app's recipe
// (MyFitnessPal and the like), a recipe website, a cookbook page or a
// handwritten list.
//
// The AI only reads the ingredient lines (food and amount). Calories are
// always worked out by our own lookup afterwards; any calories printed
// beside an ingredient are passed back separately, only so the app can
// show "ours vs the screenshot" and let the person match them if they
// want to.

export const MAX_IMAGES = 3;
export const MAX_LINES = 40;

export const RECIPE_IMPORT_PROMPT = [
  "You read recipes from screenshots or photos for a calorie tracker: another app's recipe",
  "screen, a recipe website, a cookbook page or a handwritten list. There may be several images",
  "of the same recipe (e.g. a long list scrolled across two screenshots): combine them, and",
  "don't repeat a line that appears in both.",
  "",
  "Return ONLY JSON:",
  '{"title": "<recipe name if shown, else empty>", "servings": <number of servings if shown, else null>,',
  ' "ingredients": [{"query": "<amount><unit> <food>", "as_written": "<the line as shown>",',
  ' "shown_kcal": <calories printed next to THIS ingredient, else null>, "unclear": <true|false>}]}',
  "",
  "Rules:",
  "- One entry per ingredient line. Ignore everything else: buttons, totals, daily goals, ads,",
  "  nutrition summaries, method steps.",
  "- query: amount and unit first, then the food, the way someone would type it into a calorie",
  '  tracker: "1188g tofu", "1000ml coconut milk", "3 medium courgette", "2 tbsp olive oil".',
  '  Write numbers plainly ("1,000.0 ml" -> "1000ml", "3.0 medium" -> "3 medium").',
  "  Keep brands and descriptions that are shown (\"Tofoo naked tofu\", \"chestnut mushrooms\").",
  "- If the food name is abbreviated, cut off or ambiguous (e.g. \"coco\"), put your best reading",
  "  in query (e.g. \"1000ml coconut milk\") and set unclear to true. Otherwise unclear is false.",
  "- shown_kcal: only a calorie number that is clearly printed beside that ingredient. Never",
  "  estimate or calculate one yourself. null if there isn't one.",
  "- Don't invent ingredients or amounts. If an amount isn't shown, leave it out of query.",
  `- At most ${MAX_LINES} ingredients.`,
  '- If the images don\'t show a recipe or ingredient list, return {"title": "", "servings": null, "ingredients": []}.',
].join("\n");

const text = (v, max) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

const num = (v) => {
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/**
 * The AI's answer made safe to send to the app: trimmed strings, sensible
 * numbers, no empty or duplicate lines. Exported for tests.
 */
export function cleanImport(parsed) {
  const p = parsed && typeof parsed === "object" ? parsed : {};
  const servings = num(p.servings);
  const seen = new Set();
  const ingredients = [];
  for (const raw of Array.isArray(p.ingredients) ? p.ingredients : []) {
    if (!raw || typeof raw !== "object") continue;
    const query = text(raw.query, 120);
    if (!query || !/[a-zÀ-ɏ]/i.test(query)) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kcal = num(raw.shown_kcal);
    ingredients.push({
      query,
      asWritten: text(raw.as_written, 120) || query,
      shownKcal: kcal != null && kcal >= 0 && kcal <= 20000 ? Math.round(kcal) : null,
      unclear: raw.unclear === true,
    });
    if (ingredients.length >= MAX_LINES) break;
  }
  return {
    title: text(p.title, 80),
    servings: servings != null && servings > 0 && servings <= 100 ? servings : null,
    ingredients,
  };
}

/**
 * The images from the request body ({images: [{image, mime}]}), or an
 * error message. Each image is base64 without the data: prefix.
 */
export function readImages(body, { maxTotalChars = 5_500_000 } = {}) {
  const list = Array.isArray(body?.images) ? body.images : [];
  if (!list.length) return { error: "Send at least one image" };
  if (list.length > MAX_IMAGES) return { error: `Send at most ${MAX_IMAGES} images` };
  let total = 0;
  const images = [];
  for (const item of list) {
    const image = String(item?.image || "");
    const mime = String(item?.mime || "image/jpeg");
    if (!image) return { error: "One of the images is empty" };
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return { error: "Unsupported image type" };
    total += image.length;
    images.push({ image, mime });
  }
  if (total > maxTotalChars) return { error: "Those images are too big. Try fewer, or smaller ones." };
  return { images };
}
