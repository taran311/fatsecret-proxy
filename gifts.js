// Lifetime Premium gift codes.
//
// You (an admin) make a code in the app (Menu → Gift codes) and send it to
// a friend. They enter it under Premium → "Have a code?" and get Premium
// for good: no card, no subscription. Each code works once.
//
// Codes live at meta/gifts/codes/{CODE} (CODE without dashes, e.g.
// "7KQ2M9XD"). The app can't read or write anything under meta, so only
// this server can create, list or redeem them.
//   created_by, created_at, note,
//   redeemed_by, redeemed_at, redeemed_name, cancelled
//
// Admins: set ADMIN_UIDS (comma-separated Firebase uids) and/or
// ADMIN_EMAILS (comma-separated sign-in emails) on the server.
//
// Routes (all need sign-in):
//   GET  /gift/admin    → { admin: boolean }
//   POST /gift/create   { note? }  → { code }               (admins)
//   GET  /gift/list     → { codes: [...] }                  (admins)
//   POST /gift/cancel   { code }   → { ok }                 (admins)
//   POST /gift/redeem   { code }   → { ok, stillPaying }

import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { mirrorPremium } from "./billing.js";

// No 0/O, 1/I/L or U, so codes are easy to read out and type.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function isAdmin(user) {
  if (!user?.uid) return false;
  const uids = list(process.env.ADMIN_UIDS);
  const emails = list(process.env.ADMIN_EMAILS).map((e) => e.toLowerCase());
  return (
    uids.includes(user.uid) ||
    (!!user.email && emails.includes(String(user.email).toLowerCase()))
  );
}

/** A new random code, e.g. "7KQ2M9XD". */
export function newCode() {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return out;
}

/** "cc-7kq2 m9xd" → "7KQ2M9XD" (null if it can't be a code). */
export function normaliseCode(input) {
  let s = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("CC") && s.length === CODE_LENGTH + 2) s = s.slice(2);
  if (s.length !== CODE_LENGTH) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

/** "7KQ2M9XD" → "CC-7KQ2-M9XD", how codes are shown and shared. */
export function displayCode(code) {
  return `CC-${code.slice(0, 4)}-${code.slice(4)}`;
}

const codesRef = () =>
  getFirestore().collection("meta").doc("gifts").collection("codes");

export function registerGifts(app, { requireFirebaseUser, firestoreReady }) {
  // Generous for real people, hopeless for guessing codes.
  const redeemLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => (req.user?.uid ? `uid:${req.user.uid}` : `ip:${req.ip}`),
    message: { error: "Too many tries. Try again in an hour." },
  });

  const needAdmin = (req, res, next) => {
    if (!firestoreReady) return res.status(503).json({ error: "Not available right now." });
    if (!isAdmin(req.user)) return res.status(403).json({ error: "Not allowed." });
    return next();
  };

  app.get("/gift/admin", requireFirebaseUser, (req, res) => {
    res.json({ admin: firestoreReady && isAdmin(req.user) });
  });

  app.post("/gift/create", requireFirebaseUser, needAdmin, async (req, res) => {
    const note = String(req.body?.note || "").trim().slice(0, 60);
    try {
      // A clash is vanishingly unlikely, but never reuse a code.
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        try {
          await codesRef().doc(code).create({
            created_by: req.user.uid,
            created_at: FieldValue.serverTimestamp(),
            note,
            redeemed_by: null,
            redeemed_at: null,
            cancelled: false,
          });
          return res.json({ code: displayCode(code) });
        } catch (err) {
          if (err?.code === 6 /* ALREADY_EXISTS */) continue;
          throw err;
        }
      }
      return res.status(500).json({ error: "Couldn't make a code. Try again." });
    } catch (err) {
      console.error("[gift/create]", err.message || err);
      return res.status(500).json({ error: "Couldn't make a code. Try again." });
    }
  });

  app.get("/gift/list", requireFirebaseUser, needAdmin, async (req, res) => {
    try {
      const snap = await codesRef().orderBy("created_at", "desc").limit(200).get();
      const iso = (t) => (t?.toDate ? t.toDate().toISOString() : null);
      return res.json({
        codes: snap.docs.map((d) => {
          const x = d.data() || {};
          return {
            code: displayCode(d.id),
            note: x.note || "",
            createdAt: iso(x.created_at),
            redeemedAt: iso(x.redeemed_at),
            redeemedName: x.redeemed_name || (x.redeemed_by ? "Someone" : null),
            cancelled: x.cancelled === true,
          };
        }),
      });
    } catch (err) {
      console.error("[gift/list]", err.message || err);
      return res.status(500).json({ error: "Couldn't load your codes." });
    }
  });

  app.post("/gift/cancel", requireFirebaseUser, needAdmin, async (req, res) => {
    const code = normaliseCode(req.body?.code);
    if (!code) return res.status(400).json({ error: "That isn't a code." });
    try {
      const ref = codesRef().doc(code);
      const result = await getFirestore().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return "missing";
        if (snap.data()?.redeemed_by) return "used";
        tx.update(ref, { cancelled: true });
        return "ok";
      });
      if (result === "missing") return res.status(404).json({ error: "No such code." });
      if (result === "used") {
        return res.status(409).json({ error: "That code has already been used." });
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error("[gift/cancel]", err.message || err);
      return res.status(500).json({ error: "Couldn't cancel it. Try again." });
    }
  });

  app.post("/gift/redeem", requireFirebaseUser, redeemLimiter, async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Sign in first." });
    if (!firestoreReady) return res.status(503).json({ error: "Not available right now." });
    const code = normaliseCode(req.body?.code);
    if (!code) {
      return res.status(400).json({ error: "That doesn't look like a code. Check it and try again." });
    }
    const db = getFirestore();
    const codeRef = codesRef().doc(code);
    const billingRef = db.collection("billing").doc(uid);
    const userRef = db.collection("users").doc(uid);
    try {
      // Check and use the code in one step, so it only ever works once.
      const outcome = await db.runTransaction(async (tx) => {
        const [codeSnap, billingSnap, userSnap] = await Promise.all([
          tx.get(codeRef),
          tx.get(billingRef),
          tx.get(userRef),
        ]);
        if (!codeSnap.exists) return { error: 404 };
        const c = codeSnap.data() || {};
        if (c.cancelled) return { error: 410 };
        if (c.redeemed_by) return { error: c.redeemed_by === uid ? 208 : 409 };
        const billing = billingSnap.data() || {};
        if (billing.lifetime === true) return { error: 208 };
        const user = userSnap.data() || {};
        const name =
          (typeof user.display_name === "string" && user.display_name.trim()) ||
          (typeof user.username === "string" && user.username ? `@${user.username}` : "") ||
          (req.user.email ? String(req.user.email).split("@")[0] : "") ||
          "Someone";
        tx.update(codeRef, {
          redeemed_by: uid,
          redeemed_at: FieldValue.serverTimestamp(),
          redeemed_name: name.slice(0, 40),
        });
        tx.set(
          billingRef,
          {
            lifetime: true,
            lifetime_code: code,
            lifetime_since: Timestamp.now(),
          },
          { merge: true }
        );
        return { billing: { ...billing, lifetime: true } };
      });

      if (outcome.error === 404) {
        return res.status(404).json({ error: "That code doesn't exist. Check it and try again." });
      }
      if (outcome.error === 410) {
        return res.status(410).json({ error: "That code has been cancelled." });
      }
      if (outcome.error === 409) {
        return res.status(409).json({ error: "That code has already been used." });
      }
      if (outcome.error === 208) {
        return res.json({ ok: true, already: true, stillPaying: false });
      }

      // Aurora on their card, and the mirror friends see.
      await mirrorPremium(uid, outcome.billing).catch((err) =>
        console.error("[gift/redeem] mirror failed:", err.message || err)
      );
      const b = outcome.billing;
      const PAID = new Set(["active", "trialing", "past_due"]);
      const stillPaying = !!b.stripe_subscription_id && PAID.has(b.status) && !b.cancel_at_period_end;
      console.log(`[gift/redeem] ${uid} redeemed a code`);
      return res.json({ ok: true, stillPaying });
    } catch (err) {
      console.error("[gift/redeem]", err.message || err);
      return res.status(500).json({ error: "Couldn't use that code. Try again." });
    }
  });
}
