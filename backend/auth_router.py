"""
auth_router.py — Login / register / refresh / signout + RPC endpoints.
Replaces Supabase auth.signInWithPassword, signUp, signOut, getSession,
and all supabase.rpc() calls the frontend makes.
"""
from __future__ import annotations
import hashlib, logging, os
from datetime import datetime, timezone, timedelta
from typing import Any

import bcrypt
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

import db
from permissions import (
    caller_identity, create_access_token, create_refresh_token,
    decode_token, is_admin, is_manager_or_admin, REFRESH_TTL,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])
rpc_router = APIRouter(prefix="/api/rpc", tags=["rpc"])
log = logging.getLogger(__name__)


# ── helpers ──────────────────────────────────────────────────────────────────

def _hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def _verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _user_context(user_id: str) -> tuple[list[str], list[str]]:
    """Return (roles, plant_assignments) for a user."""
    roles_rows = await db.fetch(
        "SELECT role FROM user_roles WHERE user_id = $1", user_id
    )
    roles = [r["role"] for r in roles_rows]

    profile = await db.fetchrow(
        "SELECT plant_assignments FROM user_profiles WHERE id = $1", user_id
    )
    assignments = [str(p) for p in (profile["plant_assignments"] if profile else [])]
    return roles, assignments


async def _build_session(user: dict) -> dict:
    user_id = str(user["id"])
    roles, assignments = await _user_context(user_id)

    access_token  = create_access_token(user_id, user["email"], roles, assignments)
    refresh_token = create_refresh_token(user_id)

    # Persist refresh token
    exp = datetime.now(timezone.utc) + timedelta(days=REFRESH_TTL)
    await db.execute(
        "INSERT INTO refresh_tokens(user_id, token_hash, expires_at) VALUES($1,$2,$3)",
        user_id, _token_hash(refresh_token), exp,
    )

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": {"id": user_id, "email": user["email"]},
    }


# ── Auth endpoints ────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class RegisterRequest(BaseModel):
    email: str
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/login")
async def login(body: LoginRequest):
    user = await db.fetchrow("SELECT * FROM users WHERE email = $1", body.email.strip().lower())
    if not user or not _verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {"data": {"session": await _build_session(user)}, "error": None}


@router.post("/register")
async def register(body: RegisterRequest):
    email = body.email.strip().lower()
    existing = await db.fetchrow("SELECT id FROM users WHERE email = $1", email)
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    pw_hash = _hash_password(body.password)
    user = await db.fetchrow(
        "INSERT INTO users(email, password_hash) VALUES($1,$2) RETURNING *",
        email, pw_hash,
    )
    # Create empty profile
    await db.execute(
        "INSERT INTO user_profiles(id) VALUES($1) ON CONFLICT DO NOTHING",
        user["id"],
    )
    return {"data": {"session": await _build_session(user)}, "error": None}


@router.post("/refresh")
async def refresh(body: RefreshRequest):
    try:
        payload = decode_token(body.refresh_token)
    except HTTPException:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Not a refresh token")

    # Validate token is still in DB (not revoked)
    stored = await db.fetchrow(
        "SELECT * FROM refresh_tokens WHERE token_hash = $1 AND expires_at > now()",
        _token_hash(body.refresh_token),
    )
    if not stored:
        raise HTTPException(status_code=401, detail="Refresh token revoked or expired")

    user_id = payload["sub"]
    user = await db.fetchrow("SELECT id, email FROM users WHERE id = $1", user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Rotate: delete old, issue new
    await db.execute("DELETE FROM refresh_tokens WHERE token_hash = $1", _token_hash(body.refresh_token))
    return {"data": {"session": await _build_session(user)}, "error": None}


@router.post("/signout")
async def signout(body: RefreshRequest | None = None, caller: dict = Depends(caller_identity)):
    if body and body.refresh_token:
        await db.execute(
            "DELETE FROM refresh_tokens WHERE token_hash = $1",
            _token_hash(body.refresh_token),
        )
    else:
        # Revoke all sessions for user
        await db.execute("DELETE FROM refresh_tokens WHERE user_id = $1", caller["sub"])
    return {"data": None, "error": None}


@router.get("/user")
async def get_user(caller: dict = Depends(caller_identity)):
    user = await db.fetchrow("SELECT id, email, created_at FROM users WHERE id = $1", caller["sub"])
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {"data": {"user": dict(user)}, "error": None}


@router.get("/session")
async def get_session(caller: dict = Depends(caller_identity)):
    """Validates the current access token and returns session info."""
    return {
        "data": {
            "session": {
                "user": {"id": caller["sub"], "email": caller.get("email")},
            }
        },
        "error": None,
    }


# ── RPC endpoints ─────────────────────────────────────────────────────────────
# These replace supabase.rpc('function_name', params) calls from the frontend.

class UpdateOwnProfileParams(BaseModel):
    _username: str = ""
    _first_name: str = ""
    _middle_name: str = ""
    _last_name: str = ""
    _suffix: str = ""
    _designation: str = ""


@rpc_router.post("/update_own_profile")
async def rpc_update_own_profile(body: UpdateOwnProfileParams, caller: dict = Depends(caller_identity)):
    await db.execute(
        """UPDATE user_profiles SET
             username    = COALESCE(NULLIF($2,''), username),
             first_name  = COALESCE(NULLIF($3,''), first_name),
             middle_name = $4,
             last_name   = COALESCE(NULLIF($5,''), last_name),
             suffix      = $6,
             designation = $7,
             updated_at  = now()
           WHERE id = $1""",
        caller["sub"], body._username, body._first_name,
        body._middle_name, body._last_name, body._suffix, body._designation,
    )
    return {"data": None, "error": None}


class CompleteOnboardingParams(BaseModel):
    _username: str
    _first_name: str
    _middle_name: str = ""
    _last_name: str
    _suffix: str = ""
    _designation: str
    _plant_assignments: list[str]


@rpc_router.post("/complete_onboarding")
async def rpc_complete_onboarding(body: CompleteOnboardingParams, caller: dict = Depends(caller_identity)):
    if not body._plant_assignments:
        raise HTTPException(status_code=400, detail="At least one plant assignment required")

    profile = await db.fetchrow(
        "SELECT profile_complete FROM user_profiles WHERE id = $1", caller["sub"]
    )
    if profile and profile["profile_complete"]:
        raise HTTPException(status_code=400, detail="Profile already complete; ask an Admin to change plant assignments")

    import uuid as uuid_mod
    assignments = [uuid_mod.UUID(p) for p in body._plant_assignments]
    await db.execute(
        """UPDATE user_profiles SET
             username          = $2,
             first_name        = $3,
             middle_name       = $4,
             last_name         = $5,
             suffix            = $6,
             designation       = $7,
             plant_assignments = $8,
             profile_complete  = TRUE,
             status            = 'Active',
             updated_at        = now()
           WHERE id = $1""",
        caller["sub"], body._username, body._first_name, body._middle_name,
        body._last_name, body._suffix, body._designation, assignments,
    )
    return {"data": None, "error": None}


class ApproveUserParams(BaseModel):
    _user_id: str
    _role: str = "Operator"
    _plant_assignments: list[str] = []


@rpc_router.post("/approve_user")
async def rpc_approve_user(body: ApproveUserParams, caller: dict = Depends(caller_identity)):
    if not is_manager_or_admin(caller):
        raise HTTPException(status_code=403, detail="Manager or Admin required")

    await db.execute(
        "UPDATE user_profiles SET status = 'Active', updated_at = now() WHERE id = $1",
        body._user_id,
    )
    await db.execute(
        "INSERT INTO user_roles(user_id, role) VALUES($1,$2) ON CONFLICT DO NOTHING",
        body._user_id, body._role,
    )
    if body._plant_assignments:
        import uuid as uuid_mod
        assignments = [uuid_mod.UUID(p) for p in body._plant_assignments]
        await db.execute(
            "UPDATE user_profiles SET plant_assignments = $2 WHERE id = $1",
            body._user_id, assignments,
        )
    return {"data": None, "error": None}


@rpc_router.get("/get_all_staff_profiles")
async def rpc_get_all_staff_profiles(caller: dict = Depends(caller_identity)):
    if not is_manager_or_admin(caller):
        raise HTTPException(status_code=403, detail="Manager or Admin required")
    rows = await db.fetch(
        """SELECT up.*, u.email FROM user_profiles up
           JOIN users u ON u.id = up.id
           ORDER BY up.last_name, up.first_name"""
    )
    return {"data": rows, "error": None}


@rpc_router.get("/get_all_user_roles")
async def rpc_get_all_user_roles(caller: dict = Depends(caller_identity)):
    if not is_manager_or_admin(caller):
        raise HTTPException(status_code=403, detail="Manager or Admin required")
    rows = await db.fetch("SELECT * FROM user_roles ORDER BY user_id")
    return {"data": rows, "error": None}
