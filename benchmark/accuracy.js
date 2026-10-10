// Accuracy check for /food/resolve.
//
// Sends each food in foods.json to the server the app uses, then compares
// the answer with reference values (USDA / UK labels, the same sources
// MyFitnessPal's "verified" entries use).
//
//   node benchmark/accuracy.js                       (local server on :3000)
//   BASE_URL=https://fatsecret-proxy.onrender.com TOKEN=<firebase id token> node benchmark/accuracy.js
//
// Writes benchmark/results.csv as well as printing a table.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.TOKEN || "";
// The server allows 30 lookups a minute; stay under it.
const GAP_MS = Number(process.env.GAP_MS) || 2100;
const DEFAULT_TOLERANCE = 15; // % kcal difference that counts as a miss

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (got, want) => (want === 0 ? (got === 0 ? 0 : 100) : ((got - want) / want) * 100);
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : "");

async function resolve(query) {
  const headers = { "Content-Type": "application/json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  // debug skips the server's cache and reports why it chose its source.
  const res = await fetch(`${BASE_URL}/food/resolve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ food: query, debug: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${body.error || res.statusText}`);
  return body;
}

const { foods } = JSON.parse(await readFile(path.join(here, "foods.json"), "utf8"));
console.log(`Checking ${foods.length} foods against ${BASE_URL}\n`);

const rows = [];
for (const [i, f] of foods.entries()) {
  if (i) await sleep(GAP_MS);
  const tol = f.tolerance ?? DEFAULT_TOLERANCE;
  try {
    const r = await resolve(f.query);
    const kcal = Number(r.calories) || 0;
    const diff = pct(kcal, f.kcal);
    rows.push({
      query: f.query,
      ref_kcal: f.kcal,
      our_kcal: Math.round(kcal),
      kcal_diff_pct: round(diff),
      ref_p: f.protein, our_p: round(Number(r.protein)),
      ref_c: f.carbs, our_c: round(Number(r.carbs)),
      ref_f: f.fat, our_f: round(Number(r.fat)),
      source: r.source || "",
      matched_name: r.name || "",
      ok: Math.abs(diff) <= tol && !r.failed,
      tolerance: tol,
      ref: f.ref,
      mfp_kcal: f.mfp_kcal ?? "",
    });
    const flag = rows.at(-1).ok ? "ok  " : "MISS";
    console.log(
      `${flag} ${f.query.padEnd(34)} ref ${String(f.kcal).padStart(4)}  ours ${String(Math.round(kcal)).padStart(4)}` +
        `  ${(diff >= 0 ? "+" : "") + round(diff)}%  [${r.source || "?"}] ${r.name || ""}`
    );
  } catch (err) {
    rows.push({ query: f.query, ref_kcal: f.kcal, error: err.message, ok: false, ref: f.ref });
    console.log(`ERR  ${f.query.padEnd(34)} ${err.message}`);
  }
}

const done = rows.filter((r) => !r.error);
const hits = done.filter((r) => r.ok).length;
const mean = done.reduce((s, r) => s + Math.abs(r.kcal_diff_pct), 0) / (done.length || 1);
const sorted = done.map((r) => Math.abs(r.kcal_diff_pct)).sort((a, b) => a - b);
const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
const bySource = {};
for (const r of done) bySource[r.source] = (bySource[r.source] || 0) + 1;

console.log(`\nWithin tolerance: ${hits}/${done.length}  (${round((hits / (done.length || 1)) * 100, 0)}%)`);
console.log(`Average kcal error: ${round(mean)}%   median: ${round(median)}%`);
console.log(`Answered by: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (rows.length - done.length) console.log(`Errors: ${rows.length - done.length}`);

const cols = ["query", "ref_kcal", "our_kcal", "kcal_diff_pct", "mfp_kcal", "ref_p", "our_p", "ref_c", "our_c",
  "ref_f", "our_f", "source", "matched_name", "ok", "tolerance", "ref", "error"];
const esc = (v) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
await writeFile(path.join(here, "results.csv"), csv + "\n");
console.log(`\nSaved benchmark/results.csv`);
