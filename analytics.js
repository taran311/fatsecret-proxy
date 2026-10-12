// Usage statistics: how many people do the things that matter (make a
// card, log food, close the day, come back), counted per day. No cookies,
// no third parties and nothing stored on anyone's device: the app tells the
// server when something happens and the server adds one to that day's
// count. The few per-person markers this needs ("already counted as active
// today", "has logged food before") live on their own users/{uid} doc, so
// they go when the account does.
//
// Read on the admin-only Stats screen (GET /admin/stats).

import rateLimit from "express-rate-limit";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { isAdmin } from "./gifts.js";

let enabled = false;

/** The UK date ("2026-10-12"), so a day matches the app's day. */
export function ukDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Whole UK days from [from] to [to]. */
export function ukDaysBetween(from, to = new Date()) {
  const a = Date.parse(`${ukDay(from)}T00:00:00Z`);
  const b = Date.parse(`${ukDay(to)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

const days = () => getFirestore().collection("meta").doc("analytics").collection("days");

/** Adds [n] to today's count of [event]. Never throws. */
export function countEvent(event, n = 1) {
  if (!enabled) return;
  days()
    .doc(ukDay())
    .set({ day: ukDay(), [event]: FieldValue.increment(n) }, { merge: true })
    .catch((err) => console.warn("Counting", event, "failed:", err.message));
}

/** What the app may report. */
const CLIENT_EVENTS = new Set(["active", "card_created", "food_logged", "day_closed"]);

export function registerAnalytics(app, { requireFirebaseUser, firestoreReady }) {
  enabled = !!firestoreReady;

  const trackLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => (req.user?.uid ? `uid:${req.user.uid}` : `ip:${req.ip}`),
    message: { error: "Too many requests." },
  });

  app.post("/track", requireFirebaseUser, trackLimiter, async (req, res) => {
    const event = String(req.body?.event || "");
    const uid = req.user?.uid;
    if (!CLIENT_EVENTS.has(event) || !uid) return res.status(400).json({ error: "Unknown event" });
    if (!enabled) return res.json({ ok: true });
    try {
      const today = ukDay();
      const userRef = getFirestore().collection("users").doc(uid);
      // Which counts this adds, decided against the person's own markers.
      const counts = await getFirestore().runTransaction(async (tx) => {
        const a = (await tx.get(userRef)).data()?.analytics || {};
        const out = [];
        const mark = {};
        if (event === "active") {
          if (a.last_active === today) return out; // once a day each
          mark.last_active = today;
          out.push("active");
        } else if (event === "card_created") {
          if (a.card_created) return out; // once ever
          mark.card_created = today;
          out.push("card_created");
        } else if (event === "food_logged") {
          out.push("food_logged");
          if (!a.first_food) {
            mark.first_food = today;
            out.push("first_food");
          }
        } else {
          out.push(event);
        }
        if (Object.keys(mark).length) tx.set(userRef, { analytics: mark }, { merge: true });
        return out;
      });
      // Coming back: the day after signing up, and a week after.
      if (counts.includes("active")) {
        try {
          const created = (await getAuth().getUser(uid)).metadata.creationTime;
          const since = created ? ukDaysBetween(new Date(created)) : null;
          if (since === 1) counts.push("back_day_1");
          if (since === 7) counts.push("back_day_7");
        } catch {}
      }
      for (const c of counts) countEvent(c);
      res.json({ ok: true });
    } catch (err) {
      console.warn("Track failed:", err.message);
      res.json({ ok: false });
    }
  });

  app.get("/admin/stats", requireFirebaseUser, async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: "Not allowed." });
    if (!enabled) return res.status(503).json({ error: "Not available right now." });
    const n = Math.min(90, Math.max(1, Number(req.query.days) || 28));
    const ids = [];
    // Step back a day at a time; around a clock change two steps can land
    // on the same UK date, so skip repeats.
    for (let i = 0; ids.length < n && i < n + 2; i++) {
      const id = ukDay(new Date(Date.now() - i * 86400000));
      if (!ids.includes(id)) ids.push(id);
    }
    try {
      const snaps = await getFirestore().getAll(...ids.map((id) => days().doc(id)));
      res.json({
        days: snaps.map((s, i) => {
          const d = s.data() || {};
          delete d.day;
          return { day: ids[i], counts: d };
        }),
      });
    } catch (err) {
      console.error("Stats failed:", err.message);
      res.status(500).json({ error: "Couldn't load the stats." });
    }
  });
}
