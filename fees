/**
 * Omni Work fee model — "fair and understandable"
 * -------------------------------------------------
 * Instead of taking the whole platform fee out of the Worker's pay
 * (the common but resented gig-economy pattern), the fee is split
 * evenly between both sides of the transaction:
 *
 *   - The Poster pays the listed rate PLUS half the fee.
 *   - The Worker receives the listed rate MINUS half the fee.
 *   - Omni Work's total cut is exactly the two halves added together.
 *
 * The listed task rate (e.g. "$60") is always the number both sides
 * negotiated and see everywhere in the app — the fee is shown as a
 * clear add-on/deduction from that number, never hidden inside it.
 *
 * This file is the single source of truth for fee math. The frontend
 * calls the same logic (a copy of computeFees) purely for display —
 * the backend numbers here are what's actually charged via Stripe.
 */

const PLATFORM_FEE_PERCENT = 10; // total take rate, split evenly across both sides
const HALF_FEE_PERCENT = PLATFORM_FEE_PERCENT / 2;

/**
 * @param {number} baseAmountCents - the listed task pay, in cents
 * @returns {{
 *   baseAmountCents: number,
 *   posterServiceFeeCents: number,
 *   workerServiceFeeCents: number,
 *   platformFeeCents: number,
 *   posterPaysCents: number,
 *   workerReceivesCents: number,
 *   feePercentEach: number,
 * }}
 */
function computeFees(baseAmountCents) {
  if (!Number.isFinite(baseAmountCents) || baseAmountCents < 0) {
    throw new Error("baseAmountCents must be a non-negative number");
  }
  const posterServiceFeeCents = Math.round(baseAmountCents * (HALF_FEE_PERCENT / 100));
  const workerServiceFeeCents = Math.round(baseAmountCents * (HALF_FEE_PERCENT / 100));
  const platformFeeCents = posterServiceFeeCents + workerServiceFeeCents;
  const posterPaysCents = baseAmountCents + posterServiceFeeCents;
  const workerReceivesCents = baseAmountCents - workerServiceFeeCents;

  return {
    baseAmountCents,
    posterServiceFeeCents,
    workerServiceFeeCents,
    platformFeeCents,
    posterPaysCents,
    workerReceivesCents,
    feePercentEach: HALF_FEE_PERCENT,
  };
}

function formatUSD(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = { computeFees, formatUSD, PLATFORM_FEE_PERCENT, HALF_FEE_PERCENT };
