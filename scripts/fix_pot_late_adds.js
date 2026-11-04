// One-off fix (app 1.3.9): savings that went into the pot when a new day
// started weren't taken back if food was then added to that day (it stays
// open until midnight). This finds those days in the current week (older
// pots have already emptied) and takes the extra back out of the pot.
//
// Only ever lowers a pot. Days where food was removed afterwards are left
// alone, and so is anything already moved onto someone's card: the pot
// never goes below 0.
//
// Dry run (just lists what it would change):
//   node scripts/fix_pot_late_adds.js
// Make the changes:
//   node scripts/fix_pot_late_adds.js --apply
//
// Needs FIREBASE_SERVICE_ACCOUNT, as the server does: run it in Render's
// Shell, or locally with that variable set.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export const DAILY_CAP = 150;

const LONDON = "Europe/London";
const dayKey = (d) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

const toDate = (v) => (v?.toDate ? v.toDate() : v instanceof Date ? v : null);
const num = (v) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Monday of this week in London, as a date key. */
export function weekStartKey(now = new Date()) {
  const key = dayKey(now);
  const [y, m, d] = key.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const weekday = (noon.getUTCDay() + 6) % 7; // Monday 0
  return dayKey(new Date(noon.getTime() - weekday * 86400000));
}

/** The date key of the day after [key]. */
export function nextKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(Date.UTC(y, m - 1, d, 12) + 86400000));
}

/**
 * What a day should have saved, given the food added to it after its
 * savings went in. Never more than it saved.
 *   saved, paid: what the day put in the pot / paid off a spread plan
 *   goal: the calorie goal; eatenBefore: food logged before the deposit
 *   late: food added to the day after the deposit
 */
export function correctedSaved({ saved, paid = 0, goal, eatenBefore, late }) {
  if (saved <= 0 || late <= 0) return saved;
  // Under the daily cap the deposit was exactly what was left (after the
  // plan); at the cap, all we know is that at least that much was left.
  const leftAtDeposit = saved < DAILY_CAP
    ? saved + paid
    : Math.max(saved + paid, goal - eatenBefore);
  const fixed = Math.min(DAILY_CAP, leftAtDeposit - late - paid);
  return Math.max(0, Math.min(saved, Math.round(fixed)));
}

async function main() {
  const apply = process.argv.includes("--apply");
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error("Set FIREBASE_SERVICE_ACCOUNT first (Render's Shell has it).");
    process.exit(1);
  }
  const account = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
  initializeApp({ credential: cert(account), projectId: account.project_id });
  const db = getFirestore();

  const today = dayKey(new Date());
  const week = weekStartKey();
  console.log(`${apply ? "Fixing" : "Dry run"}: pots for the week of ${week} (today ${today})\n`);

  const users = await db.collection("user_data").where("pots_enabled", "==", true).get();
  let fixedDays = 0;
  let taken = 0;

  for (const userDoc of users.docs) {
    const u = userDoc.data() || {};
    const uid = u.user_id;
    if (!uid || u.pot_week !== week) continue;
    const goal = num(u.calorie_goal) || num(u.protein_goal) * 4 + num(u.carbs_goal) * 4 + num(u.fats_goal) * 9;

    const logs = await db.collection("daily_logs").where("user_id", "==", uid).get();
    const days = logs.docs
      .map((d) => ({ ref: d.ref, ...d.data() }))
      .filter((l) => l.date_key >= week && l.date_key < today && num(l.pot_saved) > 0);
    if (!days.length) continue;

    const food = (await db.collection("user_food").where("user_id", "==", uid).get()).docs
      .map((d) => d.data())
      .filter((e) => e.foodCategory !== "Recipe");

    let pot = num(u.pot);
    for (const day of days) {
      const depositDay = nextKey(day.date_key);
      let eatenBefore = 0;
      let late = 0;
      for (const e of food) {
        const t = toDate(e.time_added) || toDate(e.created_at);
        if (!t || dayKey(t) !== day.date_key) continue;
        const created = toDate(e.created_at);
        // Added on a later day than the one it's for: after the deposit.
        if (created && dayKey(created) >= depositDay) late += num(e.food_calories);
        else eatenBefore += num(e.food_calories);
      }
      const saved = num(day.pot_saved);
      const fixed = correctedSaved({ saved, paid: num(day.plan_paid), goal, eatenBefore, late });
      if (fixed >= saved) continue;
      const back = Math.min(saved - fixed, pot);
      console.log(
        `${uid}  ${day.date_key}: saved ${saved}, ${Math.round(late)} added after → should be ${fixed}; ` +
          `pot ${pot} → ${pot - back}`
      );
      pot -= back;
      taken += back;
      fixedDays++;
      if (apply) {
        await day.ref.set(
          { pot_saved: fixed, pot_fix: { was: saved, at: FieldValue.serverTimestamp() } },
          { merge: true }
        );
      }
    }
    if (apply && pot !== num(u.pot)) await userDoc.ref.update({ pot });
  }

  console.log(
    `\n${fixedDays} day${fixedDays === 1 ? "" : "s"}, ${Math.round(taken)} taken back` +
      (apply ? "." : ". Nothing changed: run with --apply to make these changes.")
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
