import type { HubDeps } from "../../src/worker/hub/hub";
import type { SpotifyCooldown } from "../../src/worker/spotify/client";
export function operationFixture() {
	const accounts = new Map<
		string,
		Map<string, { revision: number; cooldown: SpotifyCooldown | null }>
	>();
	const account = (id: string): NonNullable<HubDeps["sharedSpotify"]> => {
		let states = accounts.get(id);
		if (!states) {
			states = new Map();
			accounts.set(id, states);
		}
		const map = states;
		return {
			getCooldown: async () => null,
			getSnapshot: async () => ({ revision: 0, cooldown: null }),
			setCooldown: async () => 0,
			beginRecheck: async () => false,
			finishRecheck: async () => {},
			getOperationSnapshot: async (op) => map.get(op) ?? { revision: 0, cooldown: null },
			setOperationCooldown: async (c) => {
				const old = map.get(c.operation!);
				const revision = (old?.revision ?? 0) + 1;
				map.set(c.operation!, {
					revision,
					cooldown: {
						...c,
						until:
							old?.cooldown?.until !== null && old?.cooldown?.until !== undefined
								? Math.max(old.cooldown.until, c.until ?? 0)
								: c.until,
					},
				});
				return revision;
			},
			finishOperation: async (op, revision) => {
				const state = map.get(op);
				if (state?.revision === revision) map.set(op, { revision: revision + 1, cooldown: null });
			},
		};
	};
	return { account, accounts };
}
