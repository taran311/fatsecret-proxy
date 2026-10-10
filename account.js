// Account deletion: POST /account/delete
//
// Called from Profile → Account and privacy → Delete account, after the
// user has typed DELETE. Removes everything the app stores about them,
// cancels any Stripe subscription straight away, takes them out of other
// people's friends lists, groups, challenges and games, then deletes their
// sign-in. Each step is best-effort and logged, so one missing collection
// or index never leaves the account half-deleted without trying the rest;
// the sign-in is only deleted once the data steps have run.
//
// Owner fields used by the app:
//   user_id:           user_data, user_food, daily_logs, recipes,
//                      direct_debits, weigh_ins, food_reactions
//   doc id == uid:     users, user_achievements, billing
//   other references:  friend_requests (from_user_id / to_user_id),
//                      shared_recipes (shared_by_user_id / shared_with_user_id),
//                      bill_splits (from_user_id / to_user_ids),
//                      food_reactions (owner_id), users.friends,
//                      friend_groups.members, challenges.member_ids,
//                      calorie_games.player_ids, conversations.participant_ids

import Stripe from "stripe";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const OWNED_BY_USER_ID = [
  "user_data",
  "user_food",
  "daily_logs",
  "recipes",
  "direct_debits",
  "weigh_ins",
  "food_reactions",
];

/** Deletes every document a query returns, in batches of 400. */
async function deleteQuery(query) {
  let deleted = 0;
  for (;;) {
    const snap = await query.limit(400).get();
    if (snap.empty) return deleted;
    const batch = getFirestore().batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < 400) return deleted;
  }
}

/** Runs [fn] over every document a query returns. */
async function forEachDoc(query, fn) {
  const snap = await query.get();
  for (const d of snap.docs) await fn(d);
  return snap.size;
}

async function step(log, name, fn) {
  try {
    const result = await fn();
    log.push({ step: name, ok: true, result });
  } catch (err) {
    console.error(`[account/delete] ${name} failed:`, err.message || err);
    log.push({ step: name, ok: false, error: String(err.message || err) });
  }
}

export async function deleteUserData(uid, { stripe } = {}) {
  const db = getFirestore();
  const log = [];

  // 1. Stop any paid subscription first, so nobody is charged again.
  await step(log, "stripe", async () => {
    const billing = (await db.collection("billing").doc(uid).get()).data();
    const subId = billing?.stripe_subscription_id;
    if (!subId || !stripe) return "none";
    try {
      await stripe.subscriptions.cancel(subId);
      return "cancelled";
    } catch (err) {
      // Already cancelled / doesn't exist: nothing to stop.
      if (err?.code === "resource_missing" || err?.statusCode === 404) return "gone";
      throw err;
    }
  });

  // 2. Their own data.
  for (const col of OWNED_BY_USER_ID) {
    await step(log, col, () =>
      deleteQuery(db.collection(col).where("user_id", "==", uid))
    );
  }
  await step(log, "food_reactions on their food", () =>
    deleteQuery(db.collection("food_reactions").where("owner_id", "==", uid))
  );
  await step(log, "friend_requests sent", () =>
    deleteQuery(db.collection("friend_requests").where("from_user_id", "==", uid))
  );
  await step(log, "friend_requests received", () =>
    deleteQuery(db.collection("friend_requests").where("to_user_id", "==", uid))
  );
  await step(log, "shared_recipes sent", () =>
    deleteQuery(db.collection("shared_recipes").where("shared_by_user_id", "==", uid))
  );
  await step(log, "shared_recipes received", () =>
    deleteQuery(db.collection("shared_recipes").where("shared_with_user_id", "==", uid))
  );
  await step(log, "bill_splits sent", () =>
    deleteQuery(db.collection("bill_splits").where("from_user_id", "==", uid))
  );
  await step(log, "bill_splits received", () =>
    forEachDoc(
      db.collection("bill_splits").where("to_user_ids", "array-contains", uid),
      (d) => d.ref.update({ to_user_ids: FieldValue.arrayRemove(uid) })
    )
  );

  // 3. Out of everyone else's lists.
  await step(log, "friends lists", () =>
    forEachDoc(
      db.collection("users").where("friends", "array-contains", uid),
      (d) => d.ref.update({ friends: FieldValue.arrayRemove(uid) })
    )
  );
  await step(log, "friend_groups", () =>
    forEachDoc(
      db.collection("friend_groups").where("members", "array-contains", uid),
      async (d) => {
        const data = d.data() || {};
        const left = (data.members || []).filter((m) => m !== uid);
        if (data.created_by === uid || left.length < 2) {
          await d.ref.delete();
          await db.recursiveDelete(db.collection("conversations").doc(`group_${d.id}`));
        } else {
          await d.ref.update({ members: FieldValue.arrayRemove(uid) });
        }
      }
    )
  );
  await step(log, "challenges", () =>
    forEachDoc(
      db.collection("challenges").where("member_ids", "array-contains", uid),
      async (d) => {
        const left = (d.data()?.member_ids || []).filter((m) => m !== uid);
        if (left.length === 0) await d.ref.delete();
        else await d.ref.update({ member_ids: FieldValue.arrayRemove(uid) });
      }
    )
  );
  await step(log, "calorie_games", () =>
    deleteQuery(db.collection("calorie_games").where("player_ids", "array-contains", uid))
  );
  await step(log, "conversations", () =>
    forEachDoc(
      db.collection("conversations").where("participant_ids", "array-contains", uid),
      async (d) => {
        const data = d.data() || {};
        const left = (data.participant_ids || []).filter((p) => p !== uid);
        if (!data.is_group || left.length < 2) {
          // One-to-one chats (and groups with nobody left) go entirely.
          await db.recursiveDelete(d.ref);
        } else {
          await d.ref.update({ participant_ids: FieldValue.arrayRemove(uid) });
        }
      }
    )
  );

  // 4. Their single documents.
  for (const col of ["users", "user_achievements", "billing"]) {
    await step(log, `${col}/{uid}`, () => db.collection(col).doc(uid).delete());
  }

  // 5. Finally the sign-in itself.
  await step(log, "auth", async () => {
    try {
      await getAuth().deleteUser(uid);
      return "deleted";
    } catch (err) {
      if (err?.code === "auth/user-not-found") return "gone";
      throw err;
    }
  });

  return log;
}

export function registerAccount(app, { requireFirebaseUser, firestoreReady }) {
  const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;
  // One deletion per user at a time.
  const running = new Set();

  app.post("/account/delete", requireFirebaseUser, async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Sign in again to delete your account." });
    if (!firestoreReady) {
      return res.status(503).json({ error: "Account deletion isn't available right now." });
    }
    if (req.body?.confirm !== "DELETE") {
      return res.status(400).json({ error: "Type DELETE to confirm." });
    }
    if (running.has(uid)) {
      return res.status(409).json({ error: "Already deleting your account…" });
    }
    running.add(uid);
    try {
      const log = await deleteUserData(uid, { stripe });
      const failed = log.filter((s) => !s.ok);
      console.log(`[account/delete] ${uid}: ${log.length - failed.length}/${log.length} steps ok`);
      const authStep = log.find((s) => s.step === "auth");
      if (!authStep?.ok) {
        return res.status(500).json({
          error: "We couldn't finish deleting your account. Please try again, or email support.",
        });
      }
      return res.json({ ok: true, incomplete: failed.map((s) => s.step) });
    } finally {
      running.delete(uid);
    }
  });
}
