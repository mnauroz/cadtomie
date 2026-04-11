"""
auth.py — JWT validation for CADtomie API.

Every protected endpoint declares:
    user: dict = Depends(require_auth)

The dependency decodes the Supabase-issued JWT and returns the full payload,
which includes `sub` (user UUID), `email`, and `role`.

Supports both HS256 (legacy Supabase) and RS256/ES256 (new Supabase projects).
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache

import requests
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import ExpiredSignatureError, JWTError, jwt

_security = HTTPBearer(auto_error=False)
_logger = logging.getLogger(__name__)

_JWT_AUDIENCE = "authenticated"

# Set DEV_MODE=true in .env to bypass auth for local testing
_DEV_MODE = os.environ.get("DEV_MODE", "false").lower() == "true"
_DEV_USER = {"sub": "00000000-0000-0000-0000-000000000000", "email": "dev@local", "role": "authenticated"}


def _supabase_url() -> str:
    url = os.environ.get("SUPABASE_URL", "")
    if not url:
        raise RuntimeError("SUPABASE_URL environment variable is not set")
    return url


def _jwt_secret() -> str:
    secret = os.environ.get("SUPABASE_JWT_SECRET", "")
    if not secret:
        raise RuntimeError("SUPABASE_JWT_SECRET environment variable is not set")
    return secret


@lru_cache(maxsize=1)
def _get_jwks() -> dict:
    """Fetch Supabase JWKS (public keys) — cached after first call."""
    url = f"{_supabase_url()}/auth/v1/.well-known/jwks.json"
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    return resp.json()


def require_auth(
    credentials: HTTPAuthorizationCredentials = Depends(_security),
) -> dict:
    """FastAPI dependency — validates Supabase JWT, returns decoded payload.

    Automatically handles HS256 (legacy) and RS256/ES256 (new projects).
    Raises 401 for missing / expired / invalid tokens.
    """
    if _DEV_MODE or credentials is None:
        return _DEV_USER

    token = credentials.credentials
    try:
        header = jwt.get_unverified_header(token)
        alg = header.get("alg", "HS256")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid authentication token.")

    try:
        if alg == "HS256":
            payload: dict = jwt.decode(
                token,
                _jwt_secret(),
                algorithms=["HS256"],
                audience=_JWT_AUDIENCE,
            )
        else:
            # RS256 / ES256 — verify with Supabase public JWKS
            jwks = _get_jwks()
            kid = header.get("kid")
            key = None
            for k in jwks.get("keys", []):
                if k.get("kid") == kid:
                    key = k
                    break
            if key is None and jwks.get("keys"):
                key = jwks["keys"][0]
            if key is None:
                raise HTTPException(status_code=401, detail="No matching public key found.")
            payload = jwt.decode(
                token,
                key,
                algorithms=[alg],
                audience=_JWT_AUDIENCE,
            )
        return payload
    except ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired. Please log in again.")
    except JWTError as e:
        _logger.error("JWT decode failed: %s", e)
        raise HTTPException(status_code=401, detail="Invalid authentication token.")
