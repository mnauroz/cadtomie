"""
stripe_routes.py — Stripe billing endpoints for CADtomie.

Endpoints:
  POST /billing/create-checkout  → Stripe Checkout URL (7-day trial with card)
  GET  /billing/status           → current subscription status for the caller
  POST /billing/portal           → Stripe Customer Portal URL (manage/cancel)
  POST /billing/webhook          → Stripe webhook receiver (no auth, HMAC-verified)

Environment variables required:
  STRIPE_SECRET_KEY
  STRIPE_PRICE_ID          (the recurring price ID from your Stripe dashboard)
  STRIPE_WEBHOOK_SECRET    (from `stripe listen --forward-to ...` or dashboard)
  FRONTEND_URL             (e.g. https://cadtomie.com)
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request

from auth import require_auth
from billing import _supabase, get_subscription

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")

router = APIRouter(prefix="/billing", tags=["billing"])


# ── Helpers ─────────────────────────────────────────────────────────────────

def _frontend_url() -> str:
    return os.environ.get("FRONTEND_URL", "http://localhost:5173")


def _price_id() -> str:
    pid = os.environ.get("STRIPE_PRICE_ID", "")
    if not pid:
        raise HTTPException(500, "STRIPE_PRICE_ID is not configured")
    return pid


def _ensure_stripe_key() -> None:
    if not stripe.api_key:
        raise HTTPException(500, "STRIPE_SECRET_KEY is not configured")


# ── Create Checkout Session ──────────────────────────────────────────────────

@router.post("/create-checkout")
async def create_checkout(user: dict = Depends(require_auth)):
    """Return a Stripe Checkout URL.

    - Creates a Stripe Customer linked to the Supabase user if one doesn't exist.
    - 7-day free trial is handled by Stripe (card required at signup).
    - After trial, the subscription auto-converts to paid.
    """
    _ensure_stripe_key()
    user_id: str = user["sub"]
    email: str = user.get("email", "")

    sub = get_subscription(user_id)
    customer_id: str | None = sub.get("stripe_customer_id") if sub else None

    if not customer_id:
        customer = stripe.Customer.create(
            email=email,
            metadata={"supabase_user_id": user_id},
        )
        customer_id = customer.id
        _supabase().table("subscriptions").upsert(
            {"user_id": user_id, "stripe_customer_id": customer_id, "status": "none"}
        ).execute()

    session = stripe.checkout.Session.create(
        customer=customer_id,
        mode="subscription",
        payment_method_types=["card"],
        line_items=[{"price": _price_id(), "quantity": 1}],
        subscription_data={"trial_period_days": 7},
        success_url=f"{_frontend_url()}/?checkout=success",
        cancel_url=f"{_frontend_url()}/pricing",
        allow_promotion_codes=True,
    )
    return {"url": session.url}


# ── Billing Status ───────────────────────────────────────────────────────────

@router.get("/status")
async def billing_status(user: dict = Depends(require_auth)):
    """Return the caller's current subscription status.

    The frontend uses this to decide which screen to show (app / paywall / pricing).
    It does NOT make the access decision — the backend does on every API call.
    """
    sub = get_subscription(user["sub"])
    if not sub:
        return {"status": "none"}
    return {
        "status": sub.get("status", "none"),
        "trial_ends_at": sub.get("trial_ends_at"),
        "period_ends_at": sub.get("period_ends_at"),
    }


# ── Customer Portal ──────────────────────────────────────────────────────────

@router.post("/portal")
async def customer_portal(user: dict = Depends(require_auth)):
    """Return a Stripe Customer Portal URL.

    Lets the user manage payment method, view invoices, or cancel.
    """
    _ensure_stripe_key()
    sub = get_subscription(user["sub"])
    customer_id = sub.get("stripe_customer_id") if sub else None
    if not customer_id:
        raise HTTPException(404, "No billing account found. Start a trial first.")

    portal = stripe.billing_portal.Session.create(
        customer=customer_id,
        return_url=f"{_frontend_url()}/",
    )
    return {"url": portal.url}


# ── Stripe Webhook ───────────────────────────────────────────────────────────

@router.post("/webhook")
async def stripe_webhook(request: Request):
    """Receive and process Stripe events.

    Keeps the `subscriptions` table in Supabase in sync with Stripe state.
    Verified via HMAC signature — no auth token required or accepted.
    """
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")

    if not secret:
        raise HTTPException(500, "STRIPE_WEBHOOK_SECRET is not configured")

    try:
        event = stripe.Webhook.construct_event(payload, sig, secret)
    except stripe.error.SignatureVerificationError:
        raise HTTPException(400, "Invalid webhook signature")
    except Exception as exc:
        raise HTTPException(400, f"Webhook parse error: {exc}")

    obj = event["data"]["object"]
    event_type: str = event["type"]

    if event_type in (
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.trial_will_end",
    ):
        _sync_subscription(obj)

    elif event_type == "customer.subscription.deleted":
        _sync_subscription(obj, force_status="canceled")

    elif event_type == "invoice.payment_failed":
        _mark_past_due(obj)

    elif event_type == "invoice.payment_succeeded":
        # Re-sync to clear past_due status if payment recovered
        sub_id = obj.get("subscription")
        if sub_id:
            sub_obj = stripe.Subscription.retrieve(sub_id)
            _sync_subscription(sub_obj)

    return {"received": True}


# ── Sync helpers ─────────────────────────────────────────────────────────────

def _sync_subscription(sub: dict, force_status: str | None = None) -> None:
    """Write subscription status + period end into Supabase."""
    customer_id: str = sub["customer"]
    status = force_status or sub["status"]

    period_end_ts = sub.get("current_period_end")
    period_end_iso = (
        datetime.fromtimestamp(period_end_ts, tz=timezone.utc).isoformat()
        if period_end_ts
        else None
    )

    trial_end_ts = sub.get("trial_end")
    trial_end_iso = (
        datetime.fromtimestamp(trial_end_ts, tz=timezone.utc).isoformat()
        if trial_end_ts
        else None
    )

    _supabase().table("subscriptions").update({
        "stripe_subscription_id": sub["id"],
        "status": status,
        "period_ends_at": period_end_iso,
        "trial_ends_at": trial_end_iso,
    }).eq("stripe_customer_id", customer_id).execute()


def _mark_past_due(invoice: dict) -> None:
    """Mark subscription as past_due when a payment fails."""
    customer_id: str = invoice["customer"]
    _supabase().table("subscriptions").update(
        {"status": "past_due"}
    ).eq("stripe_customer_id", customer_id).execute()
