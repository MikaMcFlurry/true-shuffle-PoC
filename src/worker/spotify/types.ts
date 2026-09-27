/**
 * The subset of Spotify Web API shapes true-shuffle reads, as of the
 * February 2026 Development Mode changes: playlist `tracks` → `items`,
 * playlist item `track` → `item`, no `product`/`country` on /me, no
 * batch reads, search limit 10.
 */

export interface SpImage {
	url: string;
	width?: number | null;
	height?: number | null;
}

export interface SpArtistSimple {
	id: string | null;
	name: string;
	uri?: string;
}

export interface SpAlbumSimple {
	id: string | null;
	name: string;
	images?: SpImage[];
	release_date?: string;
	album_type?: string;
	uri?: string;
}

export interface SpTrack {
	id: string | null;
	uri?: string;
	name: string;
	type?: "track" | "episode" | string;
	duration_ms: number;
	is_local?: boolean;
	is_playable?: boolean;
	artists: SpArtistSimple[];
	album?: SpAlbumSimple;
}

export interface SpPaging<T> {
	items: T[];
	next: string | null;
	total: number;
	limit: number;
	offset: number;
}

export interface SpUser {
	id: string;
	display_name: string | null;
	images?: SpImage[];
	account_id?: string;
}

export interface SpPlaylist {
	id: string;
	name: string;
	description?: string | null;
	public?: boolean | null;
	collaborative?: boolean;
	snapshot_id: string;
	owner: { id: string; display_name?: string | null };
	images?: SpImage[] | null;
	/** Renamed from `tracks` in February 2026. Omitted for playlists the user cannot read. */
	items?: { total: number; href?: string } | null;
	uri?: string;
}

export interface SpPlaylistItem {
	added_at?: string | null;
	is_local?: boolean;
	/** Renamed from `track` in February 2026. */
	item: SpTrack | null;
}

export interface SpSavedTrack {
	added_at: string;
	track: SpTrack;
}

export interface SpDevice {
	id: string | null;
	is_active: boolean;
	is_restricted: boolean;
	is_private_session?: boolean;
	name: string;
	type: string;
	volume_percent?: number | null;
}

export interface SpPlaybackState {
	device?: SpDevice | null;
	shuffle_state?: boolean;
	/** Undocumented; present on some accounts. */
	smart_shuffle?: boolean;
	repeat_state?: "off" | "track" | "context";
	timestamp?: number;
	context?: { uri: string; type: string } | null;
	progress_ms?: number | null;
	is_playing: boolean;
	item?: SpTrack | null;
	currently_playing_type?: string;
	actions?: { disallows?: Record<string, boolean> };
}

export interface SpPlayHistory {
	track: SpTrack;
	played_at: string;
	context: { uri: string; type: string } | null;
}

export interface SpCursorPaging<T> {
	items: T[];
	next: string | null;
	cursors?: { after?: string | null; before?: string | null } | null;
	limit: number;
}

export interface SpArtist {
	id: string;
	name: string;
	genres?: string[];
	images?: SpImage[];
}

export interface SpAlbum extends SpAlbumSimple {
	id: string;
	release_date: string;
	tracks: SpPaging<SpTrack>;
	artists: SpArtistSimple[];
}

export interface SpTokenResponse {
	access_token: string;
	token_type: string;
	scope?: string;
	expires_in: number;
	refresh_token?: string;
}

export interface SpErrorBody {
	error?: { status?: number; message?: string; reason?: string } | string;
	error_description?: string;
}
