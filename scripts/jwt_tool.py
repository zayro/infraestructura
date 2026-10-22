#!/usr/bin/env python3
"""CLI utility to generate and verify HS256 JWTs for Traefik dynamic-jwt-validation-middleware.
Zero external dependencies (uses standard library: hmac, hashlib, base64, json, time).
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time

DEFAULT_SECRET = os.getenv("JWT_SECRET", "super-secret-jwt-token-key-32-chars-long")
DEFAULT_ISSUER = os.getenv("JWT_ISSUER", "app-traefik")


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(data_str: str) -> bytes:
    padding = "=" * ((4 - len(data_str) % 4) % 4)
    return base64.urlsafe_b64decode(data_str + padding)


def create_token(
    sub: str,
    roles: list[str],
    email: str | None = None,
    secret: str = DEFAULT_SECRET,
    iss: str = DEFAULT_ISSUER,
    ttl_seconds: int = 86400,
) -> str:
    now = int(time.time())
    if email is None:
        email = f"{sub}@app.local"
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "iss": iss,
        "sub": sub,
        "email": email,
        "roles": roles,
        "iat": now,
        "exp": now + ttl_seconds,
    }
    header_b64 = b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_b64 = b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    sig = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header_b64}.{payload_b64}.{b64url_encode(sig)}"


def decode_token(token: str) -> dict:
    if token == "-":
        token = sys.stdin.read().strip()
    parts = token.strip().split(".")
    if len(parts) != 3:
        raise ValueError("Invalid JWT format (expected 3 parts)")
    header = json.loads(b64url_decode(parts[0]).decode("utf-8"))
    payload = json.loads(b64url_decode(parts[1]).decode("utf-8"))
    return {"header": header, "payload": payload}


def main():
    parser = argparse.ArgumentParser(description="JWT Generator for Traefik RBAC")
    subparsers = parser.add_subparsers(dest="cmd")

    gen_parser = subparsers.add_parser("generate", help="Generate a signed JWT")
    gen_parser.add_argument("--sub", default="app-service", help="Subject (user or service id)")
    gen_parser.add_argument(
        "--roles",
        default="service",
        help="Comma-separated roles (e.g. admin,user,service)",
    )
    gen_parser.add_argument("--email", default=None, help="Email claim (defaults to sub@app.local)")
    gen_parser.add_argument("--secret", default=DEFAULT_SECRET, help="HMAC secret key")
    gen_parser.add_argument("--iss", default=DEFAULT_ISSUER, help="Issuer claim")
    gen_parser.add_argument("--ttl", type=int, default=86400, help="TTL in seconds (default 1 day)")

    dec_parser = subparsers.add_parser("decode", help="Decode and inspect a JWT")
    dec_parser.add_argument("token", help="The JWT token string")

    args = parser.parse_args()

    if args.cmd == "generate" or args.cmd is None:
        sub = getattr(args, "sub", "app-service")
        roles_str = getattr(args, "roles", "service")
        roles = [r.strip() for r in roles_str.split(",") if r.strip()]
        email = getattr(args, "email", None)
        secret = getattr(args, "secret", DEFAULT_SECRET)
        iss = getattr(args, "iss", DEFAULT_ISSUER)
        ttl = getattr(args, "ttl", 86400)
        token = create_token(sub=sub, roles=roles, email=email, secret=secret, iss=iss, ttl_seconds=ttl)
        print(token)
    elif args.cmd == "decode":
        info = decode_token(args.token)
        print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
