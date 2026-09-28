/**
 * Omni Work backend — Stripe Connect integration
 * ------------------------------------------------
 * WHY THIS FILE EXISTS:
 *   The live app (a webpage) can't safely talk to Stripe directly —
 *   that would mean putting your Stripe secret key inside code anyone
 *   can view in their browser. This backend is a small, separate
 *   program that runs somewhere private, holds the secret key safely,
 *   and the webpage asks IT to do Stripe things on its behalf.
 *
 * THE FLOW:
 *   1. A Worker "sets up payouts" — this backend creates a real Stripe
 *      account for them and saves the connection in Supabase (so it's
 *      remembered even if this backend restarts).
 *   2. A Poster clicks "Pay" on a task — this backend creates a real
 *      Stripe Checkout session and hands back a link for them to pay.
 *   3. Stripe splits the payment automatically: the Worker gets their
 *      cut, Omni Work's fee is taken at the same instant — no manual
 *      transfers, no money ever sitting in this backend's own account.
 *   4. A webhook (Stripe calling US back) confirms when a payment
 *      actually completed.
 *
 * WHY SUPABASE IS USED HERE TOO:
 *   A plain JavaScript object (like `{}`) only exists in the computer's
 *   short-term memory — it's erased the moment the program restarts.
 *   Since Stripe onboarding is a real, sometimes-multi-step process for
 *   a Worker, we don't want to lose that record every time this server
 *   sleeps or redeploys. Supabase is the same permanent database the
 *   frontend already uses for tasks — this backend uses the powerful
 *   "service_role" key, which is allowed to bypass the public security
 *   rules (RLS), because this code runs somewhere private and trusted,
 *   unlike the public website.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { computeFees, formatUSD } = require("./fees");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const app = express();

// ⭐ REQUIRED FOR STRIPE WEBHOOKS ON RENDER
app.use("/api/webhooks/stripe", express.raw({ type: "*/*" }));

app.use(cors());


const STRIPE_V2_VERSION = "2026-08-26.preview";

async function stripeV2(path, method, body) {
  const res = await fetch(`https://api.stripe.com/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Stripe-Version": STRIPE_V2_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const message = (data.error && data.error.message) || `Stripe v2 API error (${res.status})`;
    throw new Error(message);
  }
  return data;
}

// --- Small helper functions for reading/writing the stripe_accounts table ---
// Keeping these separate makes the routes below easier to read: each one
// just says WHAT it wants ("get this worker's record"), not HOW the
// database call works underneath.

async function getWorkerByUserId(userId) {
  const { data, error } = await sb.from("stripe_accounts").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getWorkerByEmail(email) {
  const { data, error } = await sb.from("stripe_accounts").select("*").eq("email", email).maybeSingle();
  if (error) throw error;
  return data;
}

async function saveWorker(userId, email, fields) {
  const { error } = await sb
    .from("stripe_accounts")
    .upsert({ user_id: userId, email, ...fields }, { onConflict: "user_id" });
  if (error) throw error;
}

// Stripe webhooks need the RAW body for signature verification,
// so this route is registered BEFORE the json() body parser below.
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        console.log(`Payment completed for task ${session.metadata && session.metadata.taskId}`);
        break;
      }
      case "account.updated": {
        // v1 event — doesn't fire for v2-created Accounts (see status
        // route below, which checks live instead).
        break;
      }
      case "charge.dispute.created": {
        console.warn("A charge was disputed:", event.data.object.id);
        break;
      }
      default:
        break;
    }

    res.json({ received: true });
  }
);

app.use(express.json());

/**
 * GET /api/fees/preview?amount=60
 */
app.get("/api/fees/preview", (req, res) => {
  const dollars = Number(req.query.amount);
  if (!Number.isFinite(dollars) || dollars < 0) {
    return res.status(400).json({ error: "amount must be a non-negative number" });
  }
  const fees = computeFees(Math.round(dollars * 100));
  res.json({
    baseAmount: formatUSD(fees.baseAmountCents),
    posterPays: formatUSD(fees.posterPaysCents),
    workerReceives: formatUSD(fees.workerReceivesCents),
    platformFee: formatUSD(fees.platformFeeCents),
    feePercentEach: fees.feePercentEach,
  });
});

/**
 * POST /api/workers/:userId/onboard
 * :userId is the person's real Supabase account id (a UUID) — not a
 * made-up test name anymore, since real accounts exist now.
 * body: { email }
 */
app.post("/api/workers/:userId/onboard", async (req, res) => {
  const { userId } = req.params;
  const { email } = req.body || {};
  try {
    let worker = await getWorkerByUserId(userId);

    if (!worker) {
      const account = await stripeV2("/core/accounts", "POST", {
        contact_email: email || undefined,
        display_name: email || userId,
        dashboard: "express",
        identity: { country: "us", entity_type: "individual" },
        configuration: {
          recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
        },
        defaults: {
          currency: "usd",
          responsibilities: { fees_collector: "application", losses_collector: "application" },
        },
        include: ["configuration.recipient", "identity", "requirements"],
      });

      await saveWorker(userId, email, { stripe_account_id: account.id, payouts_enabled: false });
      worker = { stripe_account_id: account.id };
    }

    const accountLink = await stripeV2("/core/account_links", "POST", {
      account: worker.stripe_account_id,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["recipient"],
          return_url: `${process.env.APP_BASE_URL}/`,
          refresh_url: `${process.env.APP_BASE_URL}/`,
        },
      },
    });

    res.json({ onboardingUrl: accountLink.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/workers/:userId/status
 */
app.get("/api/workers/:userId/status", async (req, res) => {
  try {
    const worker = await getWorkerByUserId(req.params.userId);
    if (!worker) return res.status(404).json({ error: "Worker has not started onboarding yet" });

    const account = await stripeV2(
      `/core/accounts/${worker.stripe_account_id}?include[0]=configuration.recipient&include[1]=requirements`,
      "GET"
    );
    const cap = account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers;
    const payoutsEnabled = !!cap && cap.status === "active";

    await saveWorker(req.params.userId, worker.email, { payouts_enabled: payoutsEnabled });

    res.json({ payoutsEnabled, requirementsDue: account.requirements?.currently_due || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/tasks/:taskId/checkout
 * body: { baseAmount: 60, workerEmail: "worker@example.com", title }
 * Looks the Worker up BY EMAIL, since that's what a Poster actually
 * knows about who they're paying — not an internal account id.
 */
app.post("/api/tasks/:taskId/checkout", async (req, res) => {
  const { taskId } = req.params;
  const { baseAmount, workerEmail, title } = req.body;

  try {
    const worker = await getWorkerByEmail(workerEmail);
    if (!worker) {
      return res.status(400).json({ error: "That worker hasn't set up payouts yet" });
    }

    // Re-check live rather than trusting a possibly-stale saved flag.
    const account = await stripeV2(
      `/core/accounts/${worker.stripe_account_id}?include[0]=configuration.recipient`,
      "GET"
    );
    const cap = account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers;
    const payoutsEnabled = !!cap && cap.status === "active";
    await saveWorker(worker.user_id, worker.email, { payouts_enabled: payoutsEnabled });

    if (!payoutsEnabled) {
      return res.status(400).json({ error: "That worker hasn't finished payout setup yet" });
    }

    const fees = computeFees(Math.round(Number(baseAmount) * 100));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: title || "Omni Work task",
              description: `Includes a transparent ${fees.feePercentEach}% Omni Work service fee.`,
            },
            unit_amount: fees.posterPaysCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: fees.platformFeeCents,
        transfer_data: { destination: worker.stripe_account_id },
      },
      metadata: { taskId },
      success_url: `${process.env.APP_BASE_URL}/`,
      cancel_url: `${process.env.APP_BASE_URL}/`,
    });

    res.json({ checkoutUrl: session.url, fees });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Omni Work backend listening on port ${port}`));
