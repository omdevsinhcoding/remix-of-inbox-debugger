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

const PALETTES = [
  ["#ef4444", "#7f1d1d", "#fef2f2"],
  ["#06b6d4", "#164e63", "#ecfeff"],
  ["#22c55e", "#14532d", "#f0fdf4"],
  ["#f59e0b", "#78350f", "#fffbeb"],
  ["#ec4899", "#831843", "#fdf2f8"],
  ["#8b5cf6", "#4c1d95", "#f5f3ff"],
  ["#14b8a6", "#134e4a", "#f0fdfa"],
  ["#64748b", "#0f172a", "#f8fafc"],
];

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(arr: T[], n: number): T {
  return arr[Math.abs(n) % arr.length];
}

function svgFor(style: string, seed: string): string {
  const h = hash(`${style}:${seed}`);
  const [primary, deep, light] = pick(PALETTES, h);
  const accent = pick(PALETTES, h >>> 3)[0];
  const eye = pick(["circle", "dash", "wink", "square"], h >>> 5);
  const mouth = pick(["smile", "flat", "open", "smirk"], h >>> 7);
  const hair = pick(["cap", "waves", "spikes", "bob", "none"], h >>> 9);
  const face = pick(["#fde68a", "#fed7aa", "#fecaca", "#e9d5ff", "#bae6fd", "#bbf7d0"], h >>> 11);
  const bgShape = pick(["circle", "squircle", "diamond", "grid"], h >>> 13);
  const robot = style === "bottts" || style === "pixelArt";
  const emoji = style === "funEmoji" || style === "bigSmile";
  const anime = style === "lorelei" || style === "adventurer";

  const eyeMarkup = eye === "dash"
    ? `<path d="M45 62h10M73 62h10" stroke="${deep}" stroke-width="5" stroke-linecap="round"/>`
    : eye === "wink"
      ? `<circle cx="50" cy="62" r="4" fill="${deep}"/><path d="M74 62h10" stroke="${deep}" stroke-width="5" stroke-linecap="round"/>`
      : eye === "square"
        ? `<rect x="45" y="57" width="10" height="10" rx="2" fill="${deep}"/><rect x="73" y="57" width="10" height="10" rx="2" fill="${deep}"/>`
        : `<circle cx="50" cy="62" r="4.5" fill="${deep}"/><circle cx="78" cy="62" r="4.5" fill="${deep}"/>`;
  const mouthMarkup = mouth === "open"
    ? `<ellipse cx="64" cy="83" rx="10" ry="8" fill="${deep}"/><ellipse cx="64" cy="86" rx="6" ry="3" fill="${accent}" opacity=".8"/>`
    : mouth === "flat"
      ? `<path d="M54 83h20" stroke="${deep}" stroke-width="5" stroke-linecap="round"/>`
      : mouth === "smirk"
        ? `<path d="M52 82c8 8 22 8 31-3" stroke="${deep}" stroke-width="5" stroke-linecap="round" fill="none"/>`
        : `<path d="M50 80c8 13 28 13 36 0" stroke="${deep}" stroke-width="5" stroke-linecap="round" fill="none"/>`;
  const bgMarkup = bgShape === "grid"
    ? `<path d="M0 32h128M0 64h128M0 96h128M32 0v128M64 0v128M96 0v128" stroke="${light}" stroke-width="2" opacity=".22"/>`
    : bgShape === "diamond"
      ? `<path d="M64 8l56 56-56 56L8 64 64 8z" fill="${deep}" opacity=".35"/>`
      : bgShape === "squircle"
        ? `<rect x="14" y="14" width="100" height="100" rx="28" fill="${deep}" opacity=".34"/>`
        : `<circle cx="64" cy="64" r="54" fill="${deep}" opacity=".34"/>`;
  const hairMarkup = robot ? "" : hair === "cap"
    ? `<path d="M34 49c5-20 20-31 38-29 18 2 30 14 31 31-19-8-46-10-69-2z" fill="${deep}"/>`
    : hair === "waves"
      ? `<path d="M32 54c1-22 18-36 39-34 20 1 31 15 29 35-11-10-19 3-30-6-12-9-19 7-38 5z" fill="${deep}"/>`
      : hair === "spikes"
        ? `<path d="M34 55l7-28 12 18 11-25 12 24 14-17 7 29c-19-8-42-8-63-1z" fill="${deep}"/>`
        : hair === "bob"
          ? `<path d="M31 66c-1-29 14-48 37-48 23 0 38 19 34 48-13-11-55-11-71 0z" fill="${deep}"/>`
          : "";
  const headMarkup = robot
    ? `<rect x="34" y="36" width="60" height="58" rx="14" fill="${light}"/><path d="M48 36v-9h32v9" stroke="${light}" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="23" r="5" fill="${accent}"/>`
    : emoji
      ? `<circle cx="64" cy="66" r="40" fill="${face}"/>`
      : `<path d="M30 68c0-26 14-44 34-44s34 18 34 44c0 24-15 40-34 40S30 92 30 68z" fill="${face}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-hidden="true">
    <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${primary}"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs>
    <rect width="128" height="128" rx="22" fill="url(#g)"/>
    ${bgMarkup}
    ${anime ? `<circle cx="104" cy="28" r="10" fill="${light}" opacity=".65"/><circle cx="24" cy="102" r="8" fill="${light}" opacity=".45"/>` : ""}
    ${hairMarkup}
    ${headMarkup}
    ${robot ? `<rect x="28" y="58" width="8" height="18" rx="4" fill="${light}"/><rect x="92" y="58" width="8" height="18" rx="4" fill="${light}"/>` : ""}
    ${eyeMarkup}
    ${mouthMarkup}
    <path d="M42 106c8 8 36 8 44 0" stroke="${light}" stroke-width="8" stroke-linecap="round" opacity=".65"/>
  </svg>`;
}

/**
 * `avatarId` format remains `dicebear:<style>:<seed>` for saved compatibility.
 * Returns a lightweight local `data:image/svg+xml` URI. Returns null for legacy/unknown ids
 * so the caller can render a letter fallback.
 */
export function resolveAvatar(avatarId?: string | null): string | null {
  if (!avatarId || typeof avatarId !== "string") return null;
  if (!avatarId.startsWith("dicebear:")) return null;
  const cached = cache.get(avatarId);
  if (cached) return cached;
  const [, styleKey, seed] = avatarId.split(":");
  if (!AVATAR_CATEGORIES.some((category) => category.style === styleKey) || !seed) return null;
  const svg = svgFor(styleKey, seed);
  const uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  cache.set(avatarId, uri);
  return uri;
}

export function buildAvatarId(style: string, seed: string): string {
  return `dicebear:${style}:${seed}`;
}

export const AVATAR_TOTAL = AVATAR_CATEGORIES.reduce((n, c) => n + c.seeds.length, 0);
