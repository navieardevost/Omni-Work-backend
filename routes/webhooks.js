import express from "express";
import Stripe from "stripe";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// RAW BODY REQUIRED FOR STRIPE
router.post("/stripe", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle events
  switch (event.type) {
    case "checkout.session.completed":
      console.log("Checkout completed:", event.data.object.id);
      break;

    case "charge.dispute.created":
      console.log("Dispute created:", event.data.object.id);
      break;

    default:
      console.log("Unhandled event:", event.type);
  }

  res.status(200).send("OK");
});

export default router;
