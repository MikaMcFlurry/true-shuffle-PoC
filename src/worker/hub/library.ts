/**
 * The listener's library as the hub stores it: packed pages of tracks per
 * source (a playlist or "Lieblingssongs"), turned back into a station pool
 * and a metadata index on demand.
 */

import type { PoolEntry } from "../../core/planner";
import type { TrackMeta } from "../../core/types";
import type { StationSource } from "../../shared/api";
import type { SpTrack } from "../spotify/types";

/** [id, name, [[artistId, artistName], ...], album, imageUrl|null, durationMs] */
export type PackedTrack = [string, string, [string, string][], string, string | null, number];

export const PAGE_SIZE = 50;

export function sourceKey(s: StationSource): string {
	return s.type === "liked" ? "liked" : `pl:${s.id}`;
}

export function packTrack(t: SpTrack): PackedTrack | null {
	if (!t?.id || t.is_local || (t.type && t.type !== "track")) return null;
	if (t.is_playable === false) return null;
	const image = pickImage(t.album?.images);
	return [
		t.id,
		t.name,
		(t.artists ?? []).map((a) => [a.id ?? `name:${a.name}`, a.name] as [string, string]),
		t.album?.name ?? "",
		image,
		t.duration_ms ?? 0,
	];
}

export function pickImage(
	images: { url: string; width?: number | null }[] | null | undefined,
): string | null {
	if (!images || images.length === 0) return null;
	// Prefer the ~300 px rendition: sharp on a phone, light on data.
	const sorted = images
		.slice()
		.sort((a, b) => Math.abs((a.width ?? 300) - 300) - Math.abs((b.width ?? 300) - 300));
	return sorted[0]?.url ?? null;
}

export function unpack(p: PackedTrack): TrackMeta {
	return {
		id: p[0],
		name: p[1],
		artists: p[2].map(([id, name]) => ({ id, name })),
		albumName: p[3],
		imageUrl: p[4],
		durationMs: p[5],
	};
}

export function toPoolEntry(p: PackedTrack): PoolEntry {
	return { id: p[0], artistId: p[2][0]?.[0] ?? `solo:${p[0]}` };
}

export function artistLine(p: PackedTrack): string {
	return p[2].map(([, n]) => n).join(", ");
}
