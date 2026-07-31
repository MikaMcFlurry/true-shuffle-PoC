"""Connector contract, capability declarations, and payload parsing."""

from __future__ import annotations

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from core.models import TrackKind
from providers.apple import AppleMusicProvider, _artwork
from providers.base import (
    MusicProvider,
    PlaybackControl,
    ProviderNotConfigured,
    ProviderQuotaError,
    TokenBundle,
)
from providers.registry import all_providers, get_provider, try_get_provider
from providers.spotify import SpotifyProvider
from providers.youtube import YouTubeMusicProvider, _parse_iso8601_duration

# ---------------------------------------------------------------------------
# Registry & contract
# ---------------------------------------------------------------------------

def test_the_three_mandatory_services_are_registered():
    assert {p.capabilities.id for p in all_providers()} >= {"spotify", "apple", "youtube"}


def test_every_provider_implements_the_contract():
    for provider in all_providers():
        assert isinstance(provider, MusicProvider)
        assert provider.capabilities.id
        assert provider.capabilities.display_name


def test_every_provider_states_its_caveats():
    """Limitations belong in the UI, not buried in a README."""
    for provider in all_providers():
        assert provider.capabilities.notes, provider.capabilities.id


def test_unknown_provider_ids_raise_key_error():
    with pytest.raises(KeyError):
        get_provider("napster")
    assert try_get_provider("napster") is None


def test_an_unconfigured_provider_is_reported_not_crashed(monkeypatch):
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "")
    from app.config import get_settings
    get_settings.cache_clear()

    with pytest.raises(ProviderNotConfigured):
        get_provider("spotify")
    assert get_provider("spotify", require_configured=False) is not None


def test_capabilities_serialise_for_the_ui():
    payload = SpotifyProvider().capabilities.as_dict()
    assert payload["playback"] == "remote_device"
    assert payload["supports_controller_mode"] is True
    assert isinstance(payload["notes"], list)
    # The connect page needs this to say "not available" rather than show a gap
    # where the market and tier rows used to be.
    assert payload["reports_account_tier"] is False


def test_spotify_pages_within_the_limit_the_items_endpoint_allows():
    """GET /playlists/{id}/items caps at 50; asking for 100 is a 400 now."""
    caps = SpotifyProvider().capabilities
    assert caps.read_page_size <= 50
    # Writes were not capped down — POST /playlists/{id}/items still takes 100.
    assert caps.write_batch_size == 100


def test_only_spotify_stopped_reporting_the_account_tier():
    assert SpotifyProvider().capabilities.reports_account_tier is False
    assert AppleMusicProvider().capabilities.reports_account_tier is True
    assert YouTubeMusicProvider().capabilities.reports_account_tier is True


# ---------------------------------------------------------------------------
# Playback model — the structural difference between the services
# ---------------------------------------------------------------------------

def test_spotify_is_remote_controlled_and_apple_and_youtube_play_in_the_browser():
    assert SpotifyProvider().capabilities.playback is PlaybackControl.REMOTE_DEVICE
    assert AppleMusicProvider().capabilities.playback is PlaybackControl.WEB_PLAYER
    assert YouTubeMusicProvider().capabilities.playback is PlaybackControl.WEB_PLAYER


def test_all_three_support_live_mode():
    for provider in all_providers():
        assert provider.capabilities.supports_controller_mode


def test_only_spotify_takes_a_context_window():
    """ADR-002: ``supports_queue_prefetch`` was retired with the additive
    queue path (SP-008) — the uris window is the execution strategy now.
    Apple and YouTube play in the browser, one title at a time, so their
    connectors have no server-side context to hand a window to."""
    assert SpotifyProvider().capabilities.supports_context_window is True
    assert AppleMusicProvider().capabilities.supports_context_window is False
    assert YouTubeMusicProvider().capabilities.supports_context_window is False


# ---------------------------------------------------------------------------
# Spotify parsing
# ---------------------------------------------------------------------------

def test_spotify_track_parsing():
    # February 2026 renamed the wrapper key from "track" to "item".
    track = SpotifyProvider._to_track({
        "is_local": False,
        "item": {
            "id": "abc123", "name": "Song", "type": "track", "duration_ms": 210000,
            "artists": [{"name": "A"}, {"name": "B"}],
            "album": {"name": "Album", "images": [{"url": "big"}, {"url": "small"}]},
        },
    })
    assert track.id == "abc123"
    assert track.artist == "A, B"
    assert track.duration_ms == 210000
    assert track.artwork_url == "small"
    assert track.is_valid


def test_spotify_still_reads_the_deprecated_track_key():
    """Spotify kept emitting ``track`` as a deprecated alias beside ``item``."""
    track = SpotifyProvider._to_track({"track": {"id": "old", "name": "Legacy",
                                                 "type": "track"}})
    assert track.id == "old"
    assert track.name == "Legacy"


def test_spotify_prefers_item_over_the_deprecated_track_key():
    track = SpotifyProvider._to_track({
        "item": {"id": "new", "type": "track"},
        "track": {"id": "old", "type": "track"},
    })
    assert track.id == "new"


def test_spotify_local_files_are_flagged():
    track = SpotifyProvider._to_track({"is_local": True, "item": {"id": "x", "type": "track"}})
    assert track.is_local
    assert not track.is_valid


def test_spotify_episodes_are_flagged():
    track = SpotifyProvider._to_track({"item": {"id": "e", "type": "episode"}})
    assert track.kind is TrackKind.EPISODE
    assert not track.is_valid


def test_spotify_unavailable_track_is_flagged():
    """``is_playable`` survived February 2026 and is now the only signal left.

    ``available_markets`` and ``linked_from`` were removed from the Track
    object, so there is nothing else to cross-check availability against.
    """
    track = SpotifyProvider._to_track({"item": {"id": "u", "type": "track",
                                                "is_playable": False}})
    assert not track.is_valid


# ---------------------------------------------------------------------------
# Apple Music
# ---------------------------------------------------------------------------

def _apple_key_pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


def test_apple_reports_exactly_what_configuration_is_missing(monkeypatch):
    monkeypatch.setenv("APPLE_TEAM_ID", "")
    monkeypatch.setenv("APPLE_KEY_ID", "")
    monkeypatch.setenv("APPLE_PRIVATE_KEY", "")
    monkeypatch.setenv("APPLE_PRIVATE_KEY_PATH", "")
    from app.config import get_settings
    get_settings.cache_clear()

    missing = AppleMusicProvider().missing_config()
    assert "APPLE_TEAM_ID" in missing
    assert "APPLE_KEY_ID" in missing
    assert any("APPLE_PRIVATE_KEY" in m for m in missing)


def test_apple_developer_token_is_a_valid_es256_jwt(monkeypatch):
    monkeypatch.setenv("APPLE_TEAM_ID", "TEAM123456")
    monkeypatch.setenv("APPLE_KEY_ID", "KEY1234567")
    monkeypatch.setenv("APPLE_PRIVATE_KEY", _apple_key_pem())
    from app.config import get_settings
    get_settings.cache_clear()

    provider = AppleMusicProvider()
    assert provider.is_configured()

    token = provider.developer_token()
    header = jwt.get_unverified_header(token)
    claims = jwt.decode(token, options={"verify_signature": False})

    assert header["alg"] == "ES256"
    assert header["kid"] == "KEY1234567"
    assert claims["iss"] == "TEAM123456"
    assert claims["exp"] > claims["iat"]


def test_apple_token_lifetime_stays_inside_apples_180_day_limit(monkeypatch):
    monkeypatch.setenv("APPLE_TEAM_ID", "TEAM123456")
    monkeypatch.setenv("APPLE_KEY_ID", "KEY1234567")
    monkeypatch.setenv("APPLE_PRIVATE_KEY", _apple_key_pem())
    from app.config import get_settings
    get_settings.cache_clear()

    claims = jwt.decode(AppleMusicProvider().developer_token(),
                        options={"verify_signature": False})
    assert (claims["exp"] - claims["iat"]) <= 180 * 24 * 3600


def test_a_bad_apple_key_fails_with_an_actionable_message(monkeypatch):
    monkeypatch.setenv("APPLE_TEAM_ID", "TEAM123456")
    monkeypatch.setenv("APPLE_KEY_ID", "KEY1234567")
    monkeypatch.setenv("APPLE_PRIVATE_KEY", "not-a-pem-key")
    from app.config import get_settings
    get_settings.cache_clear()

    with pytest.raises(ProviderNotConfigured, match=r"\.p8"):
        AppleMusicProvider().developer_token()


def test_apple_library_track_uses_the_catalog_id():
    track = AppleMusicProvider._to_track({
        "id": "i.library123",
        "attributes": {
            "name": "Song", "artistName": "A", "albumName": "Album",
            "durationInMillis": 200000,
            "playParams": {"id": "i.library123", "catalogId": "1440857781"},
            "artwork": {"url": "https://x/{w}x{h}{f}"},
        },
    })
    assert track.id == "1440857781"
    assert track.is_valid


def test_apple_upload_without_a_catalog_entry_is_reported_as_unplayable():
    """Personal uploads cannot be queued by MusicKit — say so, don't drop them."""
    track = AppleMusicProvider._to_track({
        "id": "i.upload999",
        "attributes": {"name": "My demo", "playParams": {"id": "i.upload999"}},
    })
    assert track.id == "i.upload999"     # still nameable in the skipped list
    assert track.is_playable is False
    assert not track.is_valid


def test_apple_artwork_placeholders_are_filled_in():
    assert _artwork("https://x/{w}x{h}{f}", 120) == "https://x/120x120jpg"
    assert _artwork("", 120) == ""


def test_apple_has_no_remote_playback_control():
    from providers.base import Unsupported

    with pytest.raises(Unsupported):
        import asyncio
        # ADR-002 signature: play takes the uris window (here one title).
        asyncio.run(AppleMusicProvider().play(TokenBundle(access_token="t"),
                                              track_ids=["1"]))


# ---------------------------------------------------------------------------
# YouTube Music
# ---------------------------------------------------------------------------

def test_youtube_duration_parsing():
    assert _parse_iso8601_duration("PT4M13S") == 253_000
    assert _parse_iso8601_duration("PT1H2M3S") == 3_723_000
    assert _parse_iso8601_duration("PT45S") == 45_000
    assert _parse_iso8601_duration("") == 0
    assert _parse_iso8601_duration("garbage") == 0


def test_youtube_playlist_item_parsing():
    track = YouTubeMusicProvider._to_track({
        "snippet": {
            "title": "Song", "videoOwnerChannelTitle": "Artist - Topic",
            "thumbnails": {"default": {"url": "thumb"}},
            "resourceId": {"videoId": "vid123"},
        },
        "contentDetails": {"videoId": "vid123"},
        "status": {"privacyStatus": "public"},
    })
    assert track.id == "vid123"
    assert track.kind is TrackKind.VIDEO
    assert track.is_valid


def test_youtube_deleted_and_private_entries_are_unplayable():
    for title in ("Deleted video", "Private video"):
        track = YouTubeMusicProvider._to_track({
            "snippet": {"title": title, "resourceId": {"videoId": "x"}},
            "contentDetails": {"videoId": "x"},
            "status": {"privacyStatus": "private"},
        })
        assert not track.is_valid


def test_youtube_copy_quota_estimate_matches_the_documented_costs():
    provider = YouTubeMusicProvider()
    # 100 tracks: 4 read units + 50 (playlists.insert) + 100 x 50.
    assert provider.estimate_copy_quota(100) == 4 + 50 + 5000


def test_youtube_refuses_a_copy_that_cannot_fit_in_the_daily_quota():
    """A 1 500-track copy needs 75 000 units against a 10 000 budget.

    Failing in one second with an explanation beats dying at track 190.
    """
    provider = YouTubeMusicProvider()
    with pytest.raises(ProviderQuotaError, match="Live-Modus"):
        provider.check_copy_quota(1500)


def test_youtube_allows_a_small_copy():
    YouTubeMusicProvider().check_copy_quota(50)   # must not raise


def test_youtube_writes_one_track_at_a_time():
    """There is no batch insert endpoint; pretending otherwise would silently
    drop tracks."""
    assert YouTubeMusicProvider().capabilities.write_batch_size == 1
