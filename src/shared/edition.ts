/**
 * Which edition of true-shuffle a deployment is.
 *
 *  - "private": the owner's own deployment, every feature as built.
 *  - "community": the free self-hosted edition for anyone with their own
 *    Spotify developer app. It leaves out what Spotify's Developer Policy
 *    forbids for any app: no Spotify Content goes into an AI model (no AI
 *    discovery, no AI genres), and the listening profile is built only from
 *    the listener's own imported Spotify data export, never from data read
 *    through the Spotify API.
 *
 * Set with the `EDITION` variable. Unset, or anything but "community", is
 * "private", so an existing deployment keeps working exactly as before.
 */
export type Edition = "private" | "community";

export function parseEdition(value: string | null | undefined): Edition {
	return value?.trim().toLowerCase() === "community" ? "community" : "private";
}
