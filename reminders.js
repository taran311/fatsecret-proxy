// Evening "log today's food" reminders.
//
// The app saves on users/{uid}: reminder_enabled, reminder_hour (0-23,
// local), tz_offset_minutes (local minus UTC) and fcm_tokens. Every few
// minutes we look for people whose reminder hour has come round, check
// whether they've logged anything today, and if not send one friendly
// push. reminder_last_sent (a local yyyy-mm-dd) makes sure it's once a day.
//
// Needs firebase-admin initialised with a service account (see server.js).

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const APP_URL = process.env.APP_URL || "https://thecaloriecard.com/";
const CHECK_EVERY_MS = 5 * 60 * 1000;

const MESSAGES = [
  {
    title: "Quick check-in 👋",
    body: "Nothing on your card yet today. A couple of taps and you're up to date.",
  },
  {
    title: "How was today? 🍽️",
    body: "Log what you ate before bed and keep your streak going.",
  },
  {
    title: "Your card's feeling empty",
    body: "Add today's food now, while you still remember it.",
  },
  {
    title: "Don't forget today 🔥",
    body: "A quick log keeps your streak alive. Ask the Coach if you're short on time.",
  },
];

const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

const pad = (n) => String(n).padStart(2, "0");

/** Local date info for someone `offset` minutes ahead of UTC. */
export function localDay(now, offsetMinutes) {
  const local = new Date(now.getTime() + offsetMinutes * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const startUtc = new Date(Date.UTC(y, m, d) - offsetMinutes * 60000);
  return {
    hour: local.getUTCHours(),
    key: `${y}-${pad(m + 1)}-${pad(d)}`,
    startUtc,
    endUtc: new Date(startUtc.getTime() + 24 * 3600 * 1000),
    dayOfYear: Math.floor((Date.UTC(y, m, d) - Date.UTC(y, 0, 0)) / 86400000),
  };
}

function cleanOffset(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-14 * 60, Math.min(14 * 60, Math.round(n)));
}

function cleanHour(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 24 ? n : 20;
}

/** Has this person logged any food (not recipe ingredients) today? */
async function loggedToday(db, uid, day) {
  const log = await db.collection("daily_logs").doc(`${uid}_${day.key}`).get();
  if (log.exists && log.get("finished") === true) return true;

  const isEntry = (data) => data.foodCategory !== "Recipe";
  try {
    const snap = await db
      .collection("user_food")
      .where("user_id", "==", uid)
      .where("time_added", ">=", day.startUtc)
      .where("time_added", "<", day.endUtc)
      .limit(20)
      .get();
    return snap.docs.some((d) => isEntry(d.data()));
  } catch (err) {
    // No composite index yet (user_id + time_added): read their food instead.
    if (err?.code !== 9 && !/index/i.test(err?.message || "")) throw err;
    const snap = await db.collection("user_food").where("user_id", "==", uid).get();
    return snap.docs.some((d) => {
      const data = d.data();
      const t = data.time_added?.toDate?.() || data.created_at?.toDate?.();
      return isEntry(data) && t && t >= day.startUtc && t < day.endUtc;
    });
  }
}

let running = false;

/** One pass: sends whatever reminders are due right now. */
export async function sendDueReminders(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  let sent = 0;
  try {
    const db = getFirestore();
    const users = await db
      .collection("users")
      .where("reminder_enabled", "==", true)
      .get();

    for (const doc of users.docs) {
      try {
        const data = doc.data();
        const tokens = Array.isArray(data.fcm_tokens)
          ? [...new Set(data.fcm_tokens.filter((t) => typeof t === "string" && t))]
          : [];
        if (!tokens.length) continue;

        const day = localDay(now, cleanOffset(data.tz_offset_minutes));
        if (day.hour !== cleanHour(data.reminder_hour)) continue;
        if (data.reminder_last_sent === day.key) continue;

        // Mark first, so a slow send or a restart can't double up.
        await doc.ref.update({ reminder_last_sent: day.key });
        if (await loggedToday(db, doc.id, day)) continue;

        const msg = MESSAGES[day.dayOfYear % MESSAGES.length];
        const res = await getMessaging().sendEachForMulticast({
          tokens,
          notification: { title: msg.title, body: msg.body },
          webpush: {
            notification: {
              title: msg.title,
              body: msg.body,
              icon: new URL("icons/Icon-192.png", APP_URL).toString(),
              tag: "log-reminder",
            },
            fcmOptions: { link: APP_URL },
          },
          android: { notification: { tag: "log-reminder" } },
        });
        sent += res.successCount;

        const dead = res.responses
          .map((r, i) => (!r.success && DEAD_TOKEN_CODES.has(r.error?.code) ? tokens[i] : null))
          .filter(Boolean);
        if (dead.length) {
          await doc.ref.update({ fcm_tokens: FieldValue.arrayRemove(...dead) });
        }
      } catch (err) {
        console.error("[reminders] user failed:", err?.message || err);
      }
    }
  } finally {
    running = false;
  }
  if (sent) console.log(`[reminders] sent ${sent}`);
  return { sent };
}

export function startReminders() {
  const run = () =>
    sendDueReminders().catch((err) =>
      console.error("[reminders] pass failed:", err?.message || err)
    );
  setTimeout(run, 20 * 1000);
  setInterval(run, CHECK_EVERY_MS);
  console.log("[reminders] evening reminders on");
}
