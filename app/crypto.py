"""Token vault — real encryption at rest.

The previous PoC stored OAuth tokens as plain JSON while its own comments
claimed they were "encrypted at rest".  This module makes the claim true:
credentials are sealed with AES-256-GCM using a key derived from
``SECRET_KEY``, and the sealed blob carries a version prefix so the format can
be rotated later.

This protects the tokens **at rest** (a stolen ``true_shuffle.db`` is useless
on its own).  It does not protect them from someone who also has the
application's ``SECRET_KEY`` — say so plainly rather than overselling it.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Any, Dict

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_PREFIX = b"tsv1:"
_NONCE_BYTES = 12


class VaultError(Exception):
    """Raised when a sealed blob cannot be opened."""


def _derive_key(secret: str) -> bytes:
    """Derive a 32-byte AES key from the app secret.

    Scrypt with a fixed salt: the secret is a high-entropy operator-set value,
    not a user password, and a fixed salt keeps the DB decryptable across
    restarts without extra key management in a PoC.
    """
    return hashlib.scrypt(
        secret.encode("utf-8"),
        salt=b"true-shuffle/token-vault/v1",
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )


class TokenVault:
    """Seals and opens credential payloads."""

    def __init__(self, secret: str) -> None:
        if not secret:
            raise VaultError("Cannot build a token vault without a secret key")
        self._aead = AESGCM(_derive_key(secret))

    def seal(self, payload: Dict[str, Any]) -> str:
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        nonce = os.urandom(_NONCE_BYTES)
        ct = self._aead.encrypt(nonce, raw, None)
        return (_PREFIX + base64.b64encode(nonce + ct)).decode("ascii")

    def open(self, blob: str) -> Dict[str, Any]:
        if not blob:
            return {}
        data = blob.encode("ascii", errors="ignore")
        if not data.startswith(_PREFIX):
            # Legacy rows from the Spotify-only PoC held plain JSON.
            return self._open_legacy(blob)
        try:
            packed = base64.b64decode(data[len(_PREFIX):])
            nonce, ct = packed[:_NONCE_BYTES], packed[_NONCE_BYTES:]
            return json.loads(self._aead.decrypt(nonce, ct, None))
        except Exception as exc:
            raise VaultError(
                "Stored credentials could not be decrypted — SECRET_KEY changed?"
            ) from exc

    @staticmethod
    def _open_legacy(blob: str) -> Dict[str, Any]:
        try:
            data = json.loads(blob)
        except json.JSONDecodeError as exc:
            raise VaultError("Stored credentials are unreadable") from exc
        if not isinstance(data, dict):
            raise VaultError("Stored credentials have an unexpected shape")
        return data

    @staticmethod
    def is_sealed(blob: str) -> bool:
        return blob.startswith(_PREFIX.decode("ascii"))
