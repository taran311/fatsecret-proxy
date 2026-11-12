// Bowbound (the archery game) sells its full game with a Stripe Payment Link.
// Stripe calls /bowbound/stripe-webhook after a checkout; we check the call
// really came from Stripe, then mark the buyer's account as owning the full
// game in Bowbound's own Firebase project (grants/{uid}.full = true), which
// the game reads. The account's uid arrives as client_reference_id: the game
// adds it to the Payment Link.
//
// Separate from The Calorie Card's billing on purpose: its own webhook, its
// own secret, its own Firebase project. Settings (Render → Environment):
//   BOWBOUND_FIREBASE_SERVICE_ACCOUNT  service account JSON (or base64 of it)
//                                      for the bowbound-d7cc7 project
//   BOWBOUND_STRIPE_WEBHOOK_SECRET     the webhook's signing secret (whsec_...)
// Without both, the routes answer 503 and nothing else is affected.
//
// Gift codes: an admin makes a code in the game (Account → Gift codes) and
// sends it to someone, who enters it on the full-game screen and gets the
// full game for good. Each code works once. Codes live in Bowbound's
// Firestore at giftCodes/{CODE} (the game itself can't read or write them).
// Admins are the sign-in emails in ADMIN_EMAILS below (verified emails only);
// set BOWBOUND_ADMIN_EMAILS (comma-separated) to change them without a deploy.
//   GET  /bowbound/gift/admin   → { admin }
//   POST /bowbound/gift/create  { note? } → { code }      (admins)
//   GET  /bowbound/gift/list    → { codes: [...] }        (admins)
//   POST /bowbound/gift/cancel  { code }  → { ok }        (admins, unused codes)
//   POST /bowbound/gift/redeem  { code }  → { ok }        (anyone signed in)

import express from "express";
import { createHmac, timingSafeEqual, randomInt } from "node:crypto";
import rateLimit from "express-rate-limit";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PROJECT_ID = "bowbound-d7cc7";
export const WEBHOOK_PATH = "/bowbound/stripe-webhook";

/**
 * True if the Stripe-Signature header matches the raw body (Stripe's v1
 * scheme: HMAC-SHA256 of "<timestamp>.<body>") and is under 5 minutes old.
 */
export function signedByStripe(rawBody, header, secret, nowMs = Date.now()) {
  if (!rawBody || !header || !secret) return false;
  let time = null;
  const sigs = [];
  for (const part of String(header).split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") time = v;
    if (k === "v1") sigs.push(v);
  }
  if (!time || !/^\d+$/.test(time) || sigs.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(time)) > 300) return false;
  const want = createHmac("sha256", secret).update(`${time}.`).update(rawBody).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

/**
 * What to do with a Stripe event: { uid, session } to grant the full game,
 * or { skip: reason }.
 */
export function grantFor(event) {
  const paid =
    event?.type === "checkout.session.completed" ||
    event?.type === "checkout.session.async_payment_succeeded";
  if (!paid) return { skip: "ignored" };
  const session = event.data?.object || {};
  if (session.payment_status !== "paid") return { skip: "not paid yet" };
  const uid = session.client_reference_id;
  if (typeof uid !== "string" || !/^[A-Za-z0-9]{6,128}$/.test(uid)) {
    return { skip: "no account", session: session.id };
  }
  return { uid, session: session.id, livemode: event.livemode === true };
}

// ---- Gift codes ----

const ADMIN_EMAILS = ["vegthetics@gmail.com", "vegtheticsbodybuilding@gmail.com", "taz_dh@hotmail.com"];

// No 0/O, 1/I/L or U, so codes are easy to read out and type.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

/** Admins: one of the listed emails, and only once that email is verified. */
export function isBowboundAdmin(user, env = process.env.BOWBOUND_ADMIN_EMAILS) {
  if (!user?.email || user.emailVerified !== true) return false;
  const fromEnv = String(env || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const emails = fromEnv.length ? fromEnv : ADMIN_EMAILS;
  return emails.includes(String(user.email).toLowerCase());
}

/** A new random code, e.g. "7KQ2M9XD". */
export function newCode() {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** "bow-7kq2 m9xd" → "7KQ2M9XD" (null if it can't be a code). */
export function normaliseCode(input) {
  let s = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("BOW") && s.length === CODE_LENGTH + 3) s = s.slice(3);
  if (s.length !== CODE_LENGTH) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

/** "7KQ2M9XD" → "BOW-7KQ2-M9XD", how codes are shown and shared. */
export function displayCode(code) {
  return `BOW-${code.slice(0, 4)}-${code.slice(4)}`;
}

function readServiceAccount(raw) {
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(text);
  } catch (err) {
    console.error("BOWBOUND_FIREBASE_SERVICE_ACCOUNT isn't valid JSON:", err.message);
    return null;
  }
}

/** Adds the Bowbound route. Its path must skip the JSON body parser (raw body). */
export function registerBowbound(app) {
  const account = readServiceAccount(process.env.BOWBOUND_FIREBASE_SERVICE_ACCOUNT);
  const secret = process.env.BOWBOUND_STRIPE_WEBHOOK_SECRET;
  let db = null;
  let auth = null;
  if (account) {
    // A second, named Firebase app: Bowbound's project, not The Calorie Card's.
    const fb = initializeApp({ credential: cert(account), projectId: PROJECT_ID }, "bowbound");
    db = getFirestore(fb);
    auth = getAuth(fb);
  }
  console.log(`[bowbound] ${db && secret ? "on" : "off (settings missing)"}`);

  app.post(WEBHOOK_PATH, express.raw({ type: "application/json" }), async (req, res) => {
    if (!db || !secret) return res.status(503).send("Bowbound billing not configured");
    if (!signedByStripe(req.body, req.get("stripe-signature"), secret)) {
      console.warn("[bowbound] bad webhook signature");
      return res.status(400).send("Bad signature");
    }
    try {
      const grant = grantFor(JSON.parse(req.body.toString("utf8")));
      if (grant.skip) {
        // Paid with no account attached (the link was opened outside the
        // game): logged so it can be granted by hand in the Firebase console.
        if (grant.skip === "no account") console.error("[bowbound] paid checkout with no account:", grant.session);
        return res.json({ received: true, skipped: grant.skip });
      }
      await db.collection("grants").doc(grant.uid).set(
        { full: true, source: "stripe", session: grant.session, livemode: grant.livemode, at: FieldValue.serverTimestamp() },
        { merge: true }
      );
      return res.json({ received: true });
    } catch (err) {
      console.error("[bowbound] webhook failed:", err.message);
      return res.status(500).send("Webhook failed"); // Stripe retries
    }
  });

  // ---- Gift codes ----

  // Bowbound's own sign-in (its Firebase project, not The Calorie Card's).
  const needUser = async (req, res, next) => {
    if (!db || !auth) return res.status(503).json({ error: "Not available right now." });
    const match = (req.get("Authorization") || "").match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: "Sign in first." });
    try {
      const t = await auth.verifyIdToken(match[1]);
      req.bowUser = { uid: t.uid, email: t.email || null, emailVerified: t.email_verified === true };
      return next();
    } catch (err) {
      return res.status(401).json({ error: "Sign in again." });
    }
  };
  const needAdmin = (req, res, next) =>
    isBowboundAdmin(req.bowUser) ? next() : res.status(403).json({ error: "Not allowed." });

  // Generous for real people, hopeless for guessing codes.
  const redeemLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => (req.bowUser?.uid ? `bow:${req.bowUser.uid}` : `ip:${req.ip}`),
    message: { error: "Too many tries. Try again in an hour." },
  });

  const codes = () => db.collection("giftCodes");

  app.get("/bowbound/gift/admin", needUser, (req, res) => {
    res.json({ admin: isBowboundAdmin(req.bowUser) });
  });

  app.post("/bowbound/gift/create", needUser, needAdmin, async (req, res) => {
    const note = String(req.body?.note || "").trim().slice(0, 60);
    try {
      // A clash is vanishingly unlikely, but never reuse a code.
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        try {
          await codes().doc(code).create({
            created_by: req.bowUser.uid,
            created_at: FieldValue.serverTimestamp(),
            note,
            redeemed_by: null,
            redeemed_at: null,
            redeemed_name: null,
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
      console.error("[bowbound/gift/create]", err.message || err);
      return res.status(500).json({ error: "Couldn't make a code. Try again." });
    }
  });

  app.get("/bowbound/gift/list", needUser, needAdmin, async (req, res) => {
    try {
      const snap = await codes().orderBy("created_at", "desc").limit(200).get();
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
      console.error("[bowbound/gift/list]", err.message || err);
      return res.status(500).json({ error: "Couldn't load the codes." });
    }
  });

  app.post("/bowbound/gift/cancel", needUser, needAdmin, async (req, res) => {
    const code = normaliseCode(req.body?.code);
    if (!code) return res.status(400).json({ error: "That isn't a code." });
    try {
      const ref = codes().doc(code);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return "missing";
        if (snap.data()?.redeemed_by) return "used";
        tx.update(ref, { cancelled: true });
        return "ok";
      });
      if (result === "missing") return res.status(404).json({ error: "No such code." });
      if (result === "used") return res.status(409).json({ error: "That code has already been used." });
      return res.json({ ok: true });
    } catch (err) {
      console.error("[bowbound/gift/cancel]", err.message || err);
      return res.status(500).json({ error: "Couldn't cancel it. Try again." });
    }
  });

  app.post("/bowbound/gift/redeem", needUser, redeemLimiter, async (req, res) => {
    const uid = req.bowUser.uid;
    const code = normaliseCode(req.body?.code);
    if (!code) {
      return res.status(400).json({ error: "That doesn't look like a code. Check it and try again." });
    }
    const codeRef = codes().doc(code);
    const grantRef = db.collection("grants").doc(uid);
    try {
      // Check and use the code in one step, so it only ever works once.
      const outcome = await db.runTransaction(async (tx) => {
        const [codeSnap, grantSnap] = await Promise.all([tx.get(codeRef), tx.get(grantRef)]);
        if (!codeSnap.exists) return 404;
        const c = codeSnap.data() || {};
        if (c.cancelled) return 410;
        if (c.redeemed_by) return c.redeemed_by === uid ? 208 : 409;
        // Already has the full game: keep the code for someone else.
        if (grantSnap.data()?.full === true) return 208;
        tx.update(codeRef, {
          redeemed_by: uid,
          redeemed_at: FieldValue.serverTimestamp(),
          redeemed_name: (req.bowUser.email || "Someone").slice(0, 60),
        });
        tx.set(grantRef, { full: true, source: "gift", code, at: FieldValue.serverTimestamp() }, { merge: true });
        return 200;
      });
      if (outcome === 404) return res.status(404).json({ error: "That code doesn't exist. Check it and try again." });
      if (outcome === 410) return res.status(410).json({ error: "That code has been cancelled." });
      if (outcome === 409) return res.status(409).json({ error: "That code has already been used." });
      if (outcome === 208) return res.json({ ok: true, already: true });
      console.log(`[bowbound/gift/redeem] ${uid} redeemed a code`);
      return res.json({ ok: true });
    } catch (err) {
      console.error("[bowbound/gift/redeem]", err.message || err);
      return res.status(500).json({ error: "Couldn't use that code. Try again." });
    }
  });
}
