"""
billing.py — Subscription access control for CADtomie API.

Usage in endpoint:
    user: dict = Depends(require_auth)
    require_active_subscription(user)

Subscription status is stored in the `subscriptions` table in Supabase
and kept up-to-date by Stripe webhooks (see stripe_routes.py).

Required Supabase table (run once in Supabase SQL editor):
--------------------------------------------------------------
create table public.subscriptions (
  user_id                uuid references auth.users primary key,
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  status                 text not null default 'none',
  -- Stripe statuses: trialing | active | past_due | canceled | unpaid
  trial_ends_at          timestamptz,
  period_ends_at         timestamptz,
  created_at             timestamptz default now()
);

alter table public.subscriptions enable row level security;

-- Users can only read their own row (backend uses service key, bypasses RLS)
create policy "own_subscription_select" on public.subscriptions
  for select using (auth.uid() = user_id);

-- Auto-create subscription row on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.subscriptions (user_id, status)
  values (new.id, 'none')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
--------------------------------------------------------------
"""
from __future__ import annotations

import os
from functools import lru_cache

from fastapi import HTTPException
from supabase import Client, create_client


@lru_cache(maxsize=1)
def _supabase() -> Client:
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables must be set"
        )
    return create_client(url, key)


def get_subscription(user_id: str) -> dict | None:
    """Fetch subscription row for a user. Returns None if not found."""
    result = (
        _supabase()
        .table("subscriptions")
        .select("status,trial_ends_at,period_ends_at,stripe_customer_id,stripe_subscription_id")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    return result.data  # type: ignore[return-value]


def require_active_subscription(user: dict) -> None:
    """Raise HTTP 402 if the user has no active trial or paid subscription.

    Access is granted when Stripe reports status == 'trialing' or 'active'.
    All other statuses (past_due, canceled, none, unpaid) are denied.
    """
    user_id: str = user["sub"]

    try:
        sub = get_subscription(user_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Billing check failed: {exc}")

    if not sub:
        raise HTTPException(
            status_code=402,
            detail="no_subscription",
        )

    status = sub.get("status", "none")

    if status in ("trialing", "active"):
        return

    if status == "past_due":
        raise HTTPException(
            status_code=402,
            detail="payment_failed",
        )

    # canceled, unpaid, none, or any unknown value
    raise HTTPException(
        status_code=402,
        detail="subscription_required",
    )
