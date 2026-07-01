import { createAvatar } from "@dicebear/core";
import {
  funEmoji,
  bottts,
  adventurer,
  notionists,
  lorelei,
  bigSmile,
  personas,
  pixelArt,
} from "@dicebear/collection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Style = any;

const STYLE_MAP: Record<string, Style> = {
  funEmoji,
  bottts,
  adventurer,
  notionists,
  lorelei,
  bigSmile,
  personas,
  pixelArt,
};

export type AvatarCategory = {
  key: string;
  label: string;
  style: string;
  seeds: string[];
};

const SEEDS = Array.from({ length: 64 }, (_, i) => `s${String(i + 1).padStart(3, "0")}`);

export const AVATAR_CATEGORIES: AvatarCategory[] = [
  { key: "funEmoji",   label: "Emoji",       style: "funEmoji",   seeds: SEEDS },
  { key: "bottts",     label: "Bots",        style: "bottts",     seeds: SEEDS },
  { key: "adventurer", label: "Adventurers", style: "adventurer", seeds: SEEDS },
  { key: "notionists", label: "Sketch",      style: "notionists", seeds: SEEDS },
  { key: "lorelei",    label: "Anime",       style: "lorelei",    seeds: SEEDS },
  { key: "bigSmile",   label: "Big Smile",   style: "bigSmile",   seeds: SEEDS },
  { key: "personas",   label: "Personas",    style: "personas",   seeds: SEEDS },
  { key: "pixelArt",   label: "Pixel",       style: "pixelArt",   seeds: SEEDS },
];

const cache = new Map<string, string>();

/**
 * `avatarId` format: `dicebear:<style>:<seed>` e.g. `dicebear:bottts:s017`.
 * Returns a `data:image/svg+xml` URI. Returns null for legacy/unknown ids
 * so the caller can render a letter fallback.
 */
export function resolveAvatar(avatarId?: string | null): string | null {
  if (!avatarId || typeof avatarId !== "string") return null;
  if (!avatarId.startsWith("dicebear:")) return null;
  const cached = cache.get(avatarId);
  if (cached) return cached;
  const [, styleKey, seed] = avatarId.split(":");
  const style = STYLE_MAP[styleKey];
  if (!style || !seed) return null;
  const svg = createAvatar(style, { seed, size: 128 }).toString();
  const uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  cache.set(avatarId, uri);
  return uri;
}

export function buildAvatarId(style: string, seed: string): string {
  return `dicebear:${style}:${seed}`;
}

export const AVATAR_TOTAL = AVATAR_CATEGORIES.reduce((n, c) => n + c.seeds.length, 0);
