// Refer a friend: a month of Premium each.
//
// A new account's first friend counts as the person who invited them,
// however they connected (an invite link, username search or a request).
// Once the new person has logged food on REFERRAL_DAYS different days,
// both of them get REWARD_DAYS of Premium on top of whatever they have.
//
// Guards, so it can't be farmed:
//  - only accounts under NEW_ACCOUNT_DAYS old can be "invited", and the
//    inviter's account has to be older than theirs;
//  - each new account counts once, ever;
//  - nobody earns more than MAX_REWARDS_A_YEAR months in any 365 days (the
//    other person still gets theirs).
//
// Records (server only: the app can't read or write meta):
//   meta/referrals/claims/{newUid}
//     inviter, invited_at, status ('pending' | 'rewarded' | 'expired'),
//     rewarded_at, inviter_rewarded, friend_rewarded
//   meta/referrals/people/{uid}   rewards: [Timestamp...]
// The reward itself is billing/{uid}.bonus_until, which entitlementFrom
// counts as Premium (like the trial, it isn't a paid plan, so no Aurora).
//
// Route (sign-in needed):
//   POST /referral/check → { invitedBy, friends: [{ name, days, status }],
//                            earned, bonusUntil, rewardDays, daysNeeded }
// The app calls it on start and on the Friends page; it records a new
// claim, pays out any that have qualified, and returns the summary.

import rateLimit from "express-rate-limit";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { mirrorPremium, ukDayKey } from "./billing.js";
import { countEvent } from "./analytics.js";

export const REWARD_DAYS = 30;
export const REFERRAL_DAYS = 3;
export const NEW_ACCOUNT_DAYS = 14;
export const MAX_REWARDS_A_YEAR = 6;
/// A friend who hasn't qualified by then never will: stop checking.
export const CLAIM_EXPIRES_DAYS = 60;

const DAY = 24 * 3600 * 1000;

const toDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === "function") return v.toDate();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Who invited a new account: the other person on its earliest accepted
 * friend request, as long as their account is older. Null if there's
 * nobody (yet), or the account is too old to count as new.
 *   me: { uid, createdAt }
 *   requests: [{ from, to, status, at }]
 *   createdAtOf: uid → Date | null
 */
export function pickInviter(me, requests, createdAtOf, now = new Date()) {
  const created = toDate(me.createdAt);
  if (!created || now.getTime() - created.getTime() > NEW_ACCOUNT_DAYS * DAY) {
    return null;
  }
  const accepted = requests
    .filter((r) => r.status === "accepted" && (r.from === me.uid || r.to === me.uid))
    .map((r) => ({ other: r.from === me.uid ? r.to : r.from, at: toDate(r.at) }))
    .filter((r) => r.other && r.other !== me.uid)
    .sort((a, b) => (a.at?.getTime() ?? Infinity) - (b.at?.getTime() ?? Infinity));
  for (const r of accepted) {
    const theirs = toDate(createdAtOf(r.other));
    if (theirs && theirs.getTime() < created.getTime()) return r.other;
  }
  return null;
}

/** Different UK days among food entries' times. */
export function loggedDays(times) {
  const days = new Set();
  for (const t of times) {
    const d = toDate(t);
    if (d) days.add(ukDayKey(d));
  }
  return days.size;
}

/** Whether someone with these past rewards can have another. */
export function underCap(rewards, now = new Date()) {
  const since = now.getTime() - 365 * DAY;
  const recent = (rewards || []).map(toDate).filter((d) => d && d.getTime() > since);
  return recent.length < MAX_REWARDS_A_YEAR;
}

/**
 * The new bonus_until: REWARD_DAYS on top of whatever free time they have
 * left (an earlier reward or the trial), never starting in the past.
 */
export function extendBonus(billing, now = new Date()) {
  const b = billing || {};
  let from = now.getTime();
  for (const v of [b.bonus_until, b.trial_ends_at]) {
    const d = toDate(v);
    if (d && d.getTime() > from) from = d.getTime();
  }
  return new Date(from + REWARD_DAYS * DAY);
}

const root = () => getFirestore().collection("meta").doc("referrals");
const claimsRef = () => root().collection("claims");
const peopleRef = () => root().collection("people");

async function createdAt(uid) {
  try {
    const u = await getAuth().getUser(uid);
    return u.metadata?.creationTime ? new Date(u.metadata.creationTime) : null;
  } catch {
    return null;
  }
}

async function friendRequests(uid) {
  const col = getFirestore().collection("friend_requests");
  const [from, to] = await Promise.all([
    col.where("from_user_id", "==", uid).where("status", "==", "accepted").limit(50).get(),
    col.where("to_user_id", "==", uid).where("status", "==", "accepted").limit(50).get(),
  ]);
  return [...from.docs, ...to.docs].map((d) => {
    const x = d.data() || {};
    return { from: x.from_user_id, to: x.to_user_id, status: x.status, at: x.timestamp };
  });
}

async function daysLogged(uid, since) {
  const base = getFirestore().collection("user_food").where("user_id", "==", uid);
  const start = since ? since.getTime() : 0;
  let docs;
  try {
    docs = (since
      ? await base.where("time_added", ">=", Timestamp.fromDate(since)).limit(400).get()
      : await base.limit(400).get()).docs;
  } catch (err) {
    // No (user_id, time_added) index: read their food and filter here.
    if (err?.code !== 9 /* FAILED_PRECONDITION */) throw err;
    docs = (await base.limit(1000).get()).docs;
  }
  return loggedDays(
    docs
      .map((d) => toDate(d.data()?.time_added))
      .filter((t) => t && t.getTime() >= start)
  );
}

async function nameOf(uid) {
  try {
    const u = (await getFirestore().collection("users").doc(uid).get()).data() || {};
    return (
      (typeof u.display_name === "string" && u.display_name.trim()) ||
      (typeof u.username === "string" && u.username ? `@${u.username}` : "") ||
      "A friend"
    );
  } catch {
    return "A friend";
  }
}

/** Records a claim for [uid] if a new account has just made its first friend. */
async function maybeClaim(uid) {
  const ref = claimsRef().doc(uid);
  if ((await ref.get()).exists) return;
  const mine = await createdAt(uid);
  if (!mine) return;
  const requests = await friendRequests(uid);
  if (!requests.length) return;
  const others = [...new Set(requests.map((r) => (r.from === uid ? r.to : r.from)))];
  const created = new Map(await Promise.all(others.map(async (o) => [o, await createdAt(o)])));
  const inviter = pickInviter({ uid, createdAt: mine }, requests, (o) => created.get(o));
  if (!inviter) return;
  try {
    await ref.create({
      inviter,
      invited_at: Timestamp.fromDate(mine),
      status: "pending",
      created_at: FieldValue.serverTimestamp(),
    });
    countEvent("referral_claimed");
  } catch (err) {
    if (err?.code !== 6 /* ALREADY_EXISTS */) throw err;
  }
}

/**
 * Pays out [friendUid]'s claim if they've logged on enough days. Returns
 * the claim's status afterwards and how many days they've logged.
 */
async function settle(friendUid, claim, now = new Date()) {
  if (claim.status !== "pending") return { status: claim.status, days: REFERRAL_DAYS };
  const since = toDate(claim.invited_at);
  const days = await daysLogged(friendUid, since);
  if (days < REFERRAL_DAYS) {
    if (since && now.getTime() - since.getTime() > CLAIM_EXPIRES_DAYS * DAY) {
      await claimsRef().doc(friendUid).update({ status: "expired" });
      return { status: "expired", days };
    }
    return { status: "pending", days };
  }

  const db = getFirestore();
  const inviter = claim.inviter;
  const claimRef = claimsRef().doc(friendUid);
  const paid = await db.runTransaction(async (tx) => {
    const refs = [claimRef, peopleRef().doc(inviter), peopleRef().doc(friendUid),
      db.collection("billing").doc(inviter), db.collection("billing").doc(friendUid)];
    const [c, pInv, pFriend, bInv, bFriend] = await Promise.all(refs.map((r) => tx.get(r)));
    if (c.data()?.status !== "pending") return null; // another check got there first
    const out = { claim: {}, billing: {} };
    const give = (uid, person, billing, key) => {
      const rewards = person.data()?.rewards || [];
      if (!underCap(rewards, now)) return false;
      const until = extendBonus(billing.data(), now);
      tx.set(db.collection("billing").doc(uid), { bonus_until: Timestamp.fromDate(until) }, { merge: true });
      tx.set(peopleRef().doc(uid), { rewards: [...rewards, Timestamp.fromDate(now)] }, { merge: true });
      out.billing[uid] = { ...(billing.data() || {}), bonus_until: Timestamp.fromDate(until) };
      out.claim[key] = true;
      return true;
    };
    give(inviter, pInv, bInv, "inviter_rewarded");
    give(friendUid, pFriend, bFriend, "friend_rewarded");
    tx.update(claimRef, {
      status: "rewarded",
      rewarded_at: Timestamp.fromDate(now),
      inviter_rewarded: out.claim.inviter_rewarded === true,
      friend_rewarded: out.claim.friend_rewarded === true,
    });
    return out.billing;
  });
  if (paid) {
    countEvent("referral_rewarded");
    for (const [uid, billing] of Object.entries(paid)) {
      await mirrorPremium(uid, billing, { count: false }).catch(() => {});
    }
  }
  return { status: "rewarded", days };
}

export function registerReferrals(app, { requireFirebaseUser, firestoreReady }) {
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => (req.user?.uid ? `uid:${req.user.uid}` : `ip:${req.ip}`),
    message: { error: "Too many tries. Try again in a minute." },
  });

  app.post("/referral/check", requireFirebaseUser, limiter, async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Sign in first." });
    if (!firestoreReady) return res.status(503).json({ error: "Not available right now." });
    try {
      await maybeClaim(uid);

      // Me as the invited one.
      let invitedBy = null;
      const mineSnap = await claimsRef().doc(uid).get();
      if (mineSnap.exists) {
        const mine = mineSnap.data();
        const s = await settle(uid, mine);
        invitedBy = { name: await nameOf(mine.inviter), days: s.days, status: s.status };
      }

      // Me as the inviter.
      const snap = await claimsRef().where("inviter", "==", uid).limit(30).get();
      const friends = [];
      let earned = 0;
      for (const d of snap.docs) {
        const c = d.data() || {};
        const s = await settle(d.id, c);
        const after = s.status === "rewarded" && c.status !== "rewarded"
          ? (await claimsRef().doc(d.id).get()).data() || c
          : c;
        if (s.status === "rewarded" && after.inviter_rewarded !== false) earned++;
        friends.push({ name: await nameOf(d.id), days: Math.min(s.days, REFERRAL_DAYS), status: s.status });
      }

      const billing = (await getFirestore().collection("billing").doc(uid).get()).data() || {};
      const bonus = toDate(billing.bonus_until);
      return res.json({
        invitedBy,
        friends,
        earned,
        bonusUntil: bonus && bonus.getTime() > Date.now() ? bonus.toISOString() : null,
        rewardDays: REWARD_DAYS,
        daysNeeded: REFERRAL_DAYS,
      });
    } catch (err) {
      console.error("[referral/check]", err.message || err);
      return res.status(500).json({ error: "Couldn't check your invites." });
    }
  });
}
