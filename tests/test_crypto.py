"""Token vault: the "encrypted at rest" claim has to actually hold."""

from __future__ import annotations

import json

import pytest

from app.crypto import TokenVault, VaultError

PAYLOAD = {"access_token": "super-secret", "refresh_token": "also-secret"}


def test_sealed_blob_round_trips():
    vault = TokenVault("a-strong-secret")
    assert vault.open(vault.seal(PAYLOAD)) == PAYLOAD


def test_secrets_do_not_appear_in_the_sealed_blob():
    blob = TokenVault("a-strong-secret").seal(PAYLOAD)
    assert "super-secret" not in blob
    assert "also-secret" not in blob


def test_two_seals_of_the_same_payload_differ():
    """A fresh nonce each time — otherwise equal tokens are visibly equal."""
    vault = TokenVault("a-strong-secret")
    assert vault.seal(PAYLOAD) != vault.seal(PAYLOAD)


def test_a_different_key_cannot_open_the_blob():
    blob = TokenVault("key-one").seal(PAYLOAD)
    with pytest.raises(VaultError):
        TokenVault("key-two").open(blob)


def test_a_tampered_blob_is_rejected():
    vault = TokenVault("a-strong-secret")
    blob = vault.seal(PAYLOAD)
    tampered = blob[:-6] + ("A" if blob[-6] != "A" else "B") + blob[-5:]
    with pytest.raises(VaultError):
        vault.open(tampered)


def test_legacy_plain_json_rows_still_open():
    """v1 stored tokens as plain JSON; those users must not be locked out."""
    vault = TokenVault("a-strong-secret")
    assert vault.open(json.dumps(PAYLOAD)) == PAYLOAD


def test_unreadable_legacy_value_raises():
    with pytest.raises(VaultError):
        TokenVault("a-strong-secret").open("not json at all")


def test_empty_blob_is_empty_credentials():
    assert TokenVault("a-strong-secret").open("") == {}


def test_a_vault_needs_a_secret():
    with pytest.raises(VaultError):
        TokenVault("")


def test_is_sealed_distinguishes_the_formats():
    vault = TokenVault("a-strong-secret")
    assert TokenVault.is_sealed(vault.seal(PAYLOAD)) is True
    assert TokenVault.is_sealed(json.dumps(PAYLOAD)) is False
