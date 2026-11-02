/**
 * S1: how the Verlauf search compares text. Case and accents do not count
 * ("beyonce" finds "Beyoncé"): NFD, combining marks dropped, lower case.
 * A query matches when every word of it is part of the title or the artists.
 */

export function normalize(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.replace(/ß/g, "ss")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

export function queryWords(query: string): string[] {
	return normalize(query).split(" ").filter(Boolean);
}

/** Whether a song (title and artists, already normalized together) matches every word. */
export function matches(haystack: string, words: readonly string[]): boolean {
	return words.length > 0 && words.every((w) => haystack.includes(w));
}
