import { eligibleLegacy, type SpotifyCooldown } from "./client";

export interface SpotifyGateState {
	revision: number;
	cooldown: SpotifyCooldown | null;
	probe: { token: string; revision: number; startedAt: number } | null;
}
export interface SpotifyGateStore {
	get(): SpotifyGateState | null;
	set(state: SpotifyGateState): void;
}

/** Deployment-wide gate. Stores provider metadata and a probe fence, never listener identity. */
export class SpotifyGate {
	constructor(
		private readonly store: SpotifyGateStore,
		private readonly now: () => number,
	) {}
	private state(): SpotifyGateState {
		return this.store.get() ?? { revision: 0, cooldown: null, probe: null };
	}
	snapshot(probeToken?: string | null): { revision: number; cooldown: SpotifyCooldown | null } {
		const state = this.state();
		return {
			revision: state.revision,
			cooldown: probeToken && state.probe?.token === probeToken ? null : state.cooldown,
		};
	}
	get(probeToken?: string | null): SpotifyCooldown | null {
		const state = this.state();
		if (probeToken && state.probe?.token === probeToken) return null;
		return state.cooldown;
	}
	block(cooldown: SpotifyCooldown, probeToken?: string | null): number {
		const state = this.state();
		const previous = probeToken && state.probe?.token === probeToken ? null : state.cooldown;
		const until =
			previous?.until === null || cooldown.until === null
				? null
				: Math.max(previous?.until ?? 0, cooldown.until);
		const retainPrevious =
			previous &&
			previous.kind === cooldown.kind &&
			((previous.until === null &&
				(cooldown.until !== null || cooldown.observedAt < previous.observedAt)) ||
				(previous.until !== null && cooldown.until !== null && previous.until > cooldown.until));
		const source = retainPrevious ? previous : cooldown;
		this.store.set({
			revision: state.revision + 1,
			probe: null,
			cooldown: {
				...source,
				endpoint: source.scope ? source.endpoint : (previous?.endpoint ?? cooldown.endpoint),
				probePath: source.probePath ?? cooldown.probePath,
				until,
				kind: previous?.kind === "quota" ? "quota" : cooldown.kind,
			},
		});
		return state.revision + 1;
	}
	quarantine(expected: SpotifyCooldown, revision: number, catalog: SpotifyGate): boolean {
		const state = this.state();
		if (
			state.revision !== revision ||
			state.probe ||
			!eligibleLegacy(state.cooldown) ||
			JSON.stringify(state.cooldown) !== JSON.stringify(expected)
		)
			return false;
		catalog.block({ ...state.cooldown, scope: "legacy-catalog" });
		this.store.set({ revision: state.revision + 1, cooldown: null, probe: null });
		return true;
	}
	begin(token: string): string | null {
		const state = this.state();
		// This is an operation lease, not an assumed provider quota reset. No timer retries it.
		if (state.probe && this.now() - state.probe.startedAt < 30_000) return null;
		if (state.cooldown?.until !== null && (state.cooldown?.until ?? 0) > this.now()) return null;
		if (!state.cooldown) return null;
		const revision = state.revision + 1;
		this.store.set({ ...state, revision, probe: { token, revision, startedAt: this.now() } });
		return token;
	}
	finish(token: string, success: boolean): void {
		const state = this.state();
		if (state.probe?.token !== token || state.probe.revision !== state.revision) return;
		this.store.set({
			revision: state.revision + 1,
			probe: null,
			cooldown: success ? null : state.cooldown,
		});
	}
}
