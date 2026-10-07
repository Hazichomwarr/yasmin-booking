import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppointmentStatus } from "@prisma/client";

import * as booking from "@/lib/booking";
import {
  assertDetailsEditable,
  assertReschedulable,
  decideTransition,
  LIFECYCLE_TRANSITIONS,
  type LifecycleCommand,
} from "@/lib/booking/lifecycle-policy";

import { assertBookingError } from "../support/assertions";

type Expected = "apply" | "no-op" | "reject";

// The full V1 matrix: status × command.
const MATRIX: Record<AppointmentStatus, Record<LifecycleCommand, Expected>> = {
  PENDING_PAYMENT: { cancel: "apply", complete: "reject", markNoShow: "reject" },
  CONFIRMED: { cancel: "apply", complete: "apply", markNoShow: "apply" },
  COMPLETED: { cancel: "reject", complete: "no-op", markNoShow: "reject" },
  CANCELLED: { cancel: "no-op", complete: "reject", markNoShow: "reject" },
  NO_SHOW: { cancel: "reject", complete: "reject", markNoShow: "no-op" },
};

describe("lifecycle transition policy", () => {
  for (const [status, commands] of Object.entries(MATRIX) as [AppointmentStatus, Record<LifecycleCommand, Expected>][]) {
    for (const [command, expected] of Object.entries(commands) as [LifecycleCommand, Expected][]) {
      it(`${status} + ${command} → ${expected}`, async () => {
        if (expected === "reject") {
          await assertBookingError(() => decideTransition(command, status), "INVALID_APPOINTMENT_TRANSITION");
          return;
        }
        const decision = decideTransition(command, status);
        if (expected === "no-op") {
          assert.deepEqual(decision, { kind: "already-applied" });
        } else {
          assert.equal(decision.kind, "apply");
          assert.equal(decision.kind === "apply" && decision.to, LIFECYCLE_TRANSITIONS[command].to);
        }
      });
    }
  }

  it("no lifecycle command targets CONFIRMED (no confirmation backdoor)", () => {
    for (const rule of Object.values(LIFECYCLE_TRANSITIONS)) assert.notEqual(rule.to, "CONFIRMED");
  });

  it("the booking module exports no confirm function", () => {
    const confirmish = Object.keys(booking).filter((name) => /confirm/i.test(name));
    assert.deepEqual(confirmish, []);
  });

  it("only CONFIRMED appointments are reschedulable", async () => {
    assert.doesNotThrow(() => assertReschedulable("CONFIRMED"));
    for (const status of ["PENDING_PAYMENT", "COMPLETED", "CANCELLED", "NO_SHOW"] as const) {
      await assertBookingError(() => assertReschedulable(status), "APPOINTMENT_NOT_RESCHEDULABLE");
    }
  });

  it("booking details are editable only while PENDING_PAYMENT or CONFIRMED", async () => {
    assert.doesNotThrow(() => assertDetailsEditable("PENDING_PAYMENT"));
    assert.doesNotThrow(() => assertDetailsEditable("CONFIRMED"));
    for (const status of ["COMPLETED", "CANCELLED", "NO_SHOW"] as const) {
      await assertBookingError(() => assertDetailsEditable(status), "APPOINTMENT_NOT_EDITABLE");
    }
  });
});
