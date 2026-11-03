#!/usr/bin/env python3
"""Genera los JWT (service/admin/user) y actualiza las variables de la colección Postman.

Reemplaza solo el valor de cada variable para preservar el formato del JSON.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jwt_tool import create_token  # noqa: E402

DEFAULT_COLLECTION = Path(__file__).resolve().parent.parent / "postman" / "app-etapa1.postman_collection.json"

TOKENS = {
    "access_token": {"sub": "app-service", "roles": ["service"]},
    "admin_token": {"sub": "app-admin", "roles": ["admin", "user"]},
    "user_token": {"sub": "app-user", "roles": ["user"]},
}


def update_collection(path: Path, ttl: int) -> None:
    text = path.read_text(encoding="utf-8")
    for key, claims in TOKENS.items():
        token = create_token(ttl_seconds=ttl, **claims)
        pattern = re.compile(r'("key"\s*:\s*"' + re.escape(key) + r'"\s*,\s*"value"\s*:\s*")[^"]*(")')
        text, count = pattern.subn(lambda m: m.group(1) + token + m.group(2), text, count=1)
        if count != 1:
            raise SystemExit(f"Variable '{key}' no encontrada en {path}")
    json.loads(text)  # valida que el JSON resultante sea correcto
    path.write_text(text, encoding="utf-8")
    print(f"Tokens actualizados en {path}: {', '.join(TOKENS)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Actualiza los tokens JWT de la colección Postman")
    parser.add_argument("--collection", type=Path, default=DEFAULT_COLLECTION)
    parser.add_argument("--ttl", type=int, default=86400, help="TTL en segundos (default 1 día)")
    args = parser.parse_args()
    update_collection(args.collection, args.ttl)


if __name__ == "__main__":
    main()
