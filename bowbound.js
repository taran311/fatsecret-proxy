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
// Without both, the route answers 503 and nothing else is affected.

import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { initializeApp, cert } from "firebase-admin/app";
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
  if (account) {
    // A second, named Firebase app: Bowbound's project, not The Calorie Card's.
    db = getFirestore(initializeApp({ credential: cert(account), projectId: PROJECT_ID }, "bowbound"));
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
}
