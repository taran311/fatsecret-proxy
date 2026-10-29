// Refer a friend: who counts as the inviter, logging days, the yearly cap
// and how the free month stacks.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickInviter,
  loggedDays,
  underCap,
  extendBonus,
  REWARD_DAYS,
  MAX_REWARDS_A_YEAR,
} from "../referrals.js";
import { entitlementFrom } from "../billing.js";

const DAY = 24 * 3600 * 1000;
const now = new Date("2026-10-29T12:00:00Z");
const ago = (days) => new Date(now.getTime() - days * DAY);
const ts = (d) => ({ toDate: () => d });

const created = { taz: ago(400), wife: ago(300), other: ago(1), me: ago(2) };
const createdAtOf = (uid) => created[uid] ?? null;
const req = (from, to, at, status = "accepted") => ({ from, to, status, at: ts(at) });

test("a new account's first friend is the inviter", () => {
  const me = { uid: "me", createdAt: created.me };
  const requests = [req("me", "wife", ago(1)), req("taz", "me", ago(1.5))];
  assert.equal(pickInviter(me, requests, createdAtOf, now), "taz");
});

test("pending or declined requests don't count", () => {
  const me = { uid: "me", createdAt: created.me };
  assert.equal(pickInviter(me, [req("taz", "me", ago(1), "pending")], createdAtOf, now), null);
});

test("the inviter has to be an older account", () => {
  const me = { uid: "me", createdAt: created.me };
  // "other" signed up after me, so they can't have invited me.
  assert.equal(pickInviter(me, [req("other", "me", ago(1))], createdAtOf, now), null);
});

test("old accounts can't be invited", () => {
  const me = { uid: "wife", createdAt: created.wife };
  assert.equal(pickInviter(me, [req("taz", "wife", ago(1))], createdAtOf, now), null);
});

test("logging days are different UK days", () => {
  const times = [
    ts(new Date("2026-10-27T08:00:00Z")),
    ts(new Date("2026-10-27T20:00:00Z")),
    ts(new Date("2026-10-28T23:30:00Z")), // 23:30 in London (GMT)
    ts(new Date("2026-10-29T00:30:00Z")),
  ];
  assert.equal(loggedDays(times), 3);
  assert.equal(loggedDays([]), 0);
});

test(`at most ${MAX_REWARDS_A_YEAR} rewards in any year`, () => {
  const rewards = Array.from({ length: MAX_REWARDS_A_YEAR }, (_, i) => ts(ago(10 + i)));
  assert.equal(underCap(rewards, now), false);
  assert.equal(underCap(rewards.slice(1), now), true);
  // Older than a year doesn't count.
  const old = Array.from({ length: MAX_REWARDS_A_YEAR }, () => ts(ago(400)));
  assert.equal(underCap(old, now), true);
});

test("the free month stacks on whatever time is left", () => {
  const plain = extendBonus({}, now);
  assert.equal(plain.getTime(), now.getTime() + REWARD_DAYS * DAY);
  const trial = new Date(now.getTime() + 5 * DAY);
  assert.equal(extendBonus({ trial_ends_at: ts(trial) }, now).getTime(),
    trial.getTime() + REWARD_DAYS * DAY);
  const bonus = new Date(now.getTime() + 20 * DAY);
  assert.equal(extendBonus({ bonus_until: ts(bonus), trial_ends_at: ts(trial) }, now).getTime(),
    bonus.getTime() + REWARD_DAYS * DAY);
  // An expired trial doesn't push it into the past.
  assert.equal(extendBonus({ trial_ends_at: ts(ago(3)) }, now).getTime(),
    now.getTime() + REWARD_DAYS * DAY);
});

test("bonus time is Premium, but not a paid plan", () => {
  const e = entitlementFrom({ trial_ends_at: ts(ago(3)), bonus_until: ts(new Date(now.getTime() + DAY)) }, now);
  assert.equal(e.premium, true);
  assert.equal(e.inBonus, true);
  assert.equal(e.subscribed, false);
  const over = entitlementFrom({ bonus_until: ts(ago(1)) }, now);
  assert.equal(over.premium, false);
});
