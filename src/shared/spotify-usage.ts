/** Sanitized app-wide observations. No listener IDs, URLs, song data or tokens. */
export interface SpotifyUsageTotals {
	sent: number;
	read: number;
	write: number;
	refresh: number;
	blocked: number;
	quota: number;
	rate: number;
	network: number;
}
export interface SpotifyUsageOperation {
	operation: string;
	totals: SpotifyUsageTotals;
	responses: Record<string, number>;
}
export interface SpotifyUsageEpisode {
	id: number;
	listener: string;
	operation: string;
	firstFailureAt: number;
	lastFailureAt: number;
	reason: string | null;
	retryAfter: string | null;
	earliestRetryAt: number | null;
	attempts: number;
	lastAttemptAt: number;
	lastStatus: number;
	firstSuccessAt: number | null;
}
export interface SpotifyUsageReport {
	policy: "confirmed-operation-v1";
	generatedAt: number;
	startedAt: number | null;
	retentionHours: number;
	listenerCapacity: number;
	registeredListeners: number;
	observedListeners: number;
	overflowObserved: boolean;
	totals: SpotifyUsageTotals;
	listeners: Array<{ listener: string; totals: SpotifyUsageTotals }>;
	operations: SpotifyUsageOperation[];
	hours: Array<{ hour: number; totals: SpotifyUsageTotals }>;
	episodes: SpotifyUsageEpisode[];
}
