// Netflix character avatar catalog (hosted on the configured public R2 URL).
// Avatar IDs use the format: `netflix:<CategoryKey>:<FileName>` (filename without .png).

let avatarBaseUrl = "";

export function setAvatarBaseUrl(url?: string | null) {
  avatarBaseUrl = typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
}

export type AvatarCategory = {
  key: string;      // URL-safe slug used inside the ID and DOM
  label: string;    // Human-readable title shown in the picker
  folder: string;   // Folder name on R2 (matches URL path)
  files: string[];  // File names without extension
};

// Convert a filename like `Prince-Charles---Dominic-West` to `Prince Charles — Dominic West`
export function prettyName(file: string): string {
  return file
    .replace(/---/g, " — ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const AVATAR_CATEGORIES: AvatarCategory[] = [
  { key: "alice-in-borderland", label: "Alice in Borderland", folder: "Alice-in-Borderland",
    files: ["Profile-Avatar-(1)","Profile-Avatar-(10)","Profile-Avatar-(11)","Profile-Avatar-(2)","Profile-Avatar-(3)","Profile-Avatar-(4)","Profile-Avatar-(5)","Profile-Avatar-(6)","Profile-Avatar-(7)","Profile-Avatar-(8)","Profile-Avatar-(9)","Profile-Avatar"] },
  { key: "avatar-tla", label: "Avatar: The Last Airbender", folder: "Avatar-The-Last-Airbender",
    files: ["Aang","Appa","Avatar-Aang","Azula","Iroh","Katara","Momo","Ozai","Sokka","Suki","Toph","Zuko"] },
  { key: "black-mirror", label: "Black Mirror", folder: "Black-Mirror",
    files: ["Bandersnatch","Broken-Smiley-Face","Doll","Glyph","Loading-Icon","Stuffed-Animal-Monkey","Thronglet","Waldo"] },
  { key: "bojack", label: "BoJack Horseman", folder: "BoJack-Horseman",
    files: ["BoJack","Diane","Mr-Peanut-Butter","Princess-Caroline","Todd"] },
  { key: "bridgerton", label: "Bridgerton", folder: "Bridgerton",
    files: ["Anthony-Bridgerton","Benedict-Bridgerton","Colin-Bridgerton","Daphne-Bridgerton","Edwina-Sharma","Eloise-Bridgerton","Francesca-Bridgerton","Kate-Sharma","Lady-Bridgerton","Lady-Danbury","Lady-Featherington","Lady-Whistledown","Penelope-Featherington","Queen-Charlotte","Simon-Basset","Sophie-Baek"] },
  { key: "caramelo", label: "Caramelo", folder: "Caramelo",
    files: ["Caramelo-(1)","Caramelo-(2)","Caramelo-(3)","Caramelo-(4)","Caramelo-(5)","Caramelo"] },
  { key: "dark", label: "Dark", folder: "Dark",
    files: ["Claudia","Dark-Matter","Mikkel","Noah","Old-Jonas","Old-Marta","Tannhaus","Time-Machine","Trinity-Knot","Young-Jonas","Young-Marta"] },
  { key: "family-pack", label: "Family Pack", folder: "Family-Pack",
    files: ["The-Dad","The-Hunter","The-Little-Girl","The-Thief","The-Tile","The-Werewolf","The-Witch"] },
  { key: "frankenstein", label: "Frankenstein", folder: "Frankenstein",
    files: ["Creature","Dark-Angel","Elizabeth","Heinrich","Victor","William"] },
  { key: "heeramandi", label: "Heeramandi", folder: "Heeramandi-The-Diamond-Bazaar",
    files: ["Alamzeb","Alastair-Cartwright","Bibbojaan","Fareedan","Lajjo","Mallikajaan","Qudsia-Begum","Tajdar-Baloch","Ustaadji","Waheeda","Wali-Mohammad","Zorawar","Zulfikar"] },
  { key: "kpop-demon-hunters", label: "KPop Demon Hunters", folder: "KPop-Demon-Hunters",
    files: ["Abby-Saja","Baby-Saja","Bobby","Derpy","Jinu","Mira","Mystery-Saja","Romance-Saja","Rumi","Sussie","Zoey"] },
  { key: "leo", label: "Leo", folder: "Leo",
    files: ["Anthony","Cole","Jayda","Kindergartener","Leo","Ms-Malkin","Squirtle","Summer","The-Drone"] },
  { key: "lost-in-space", label: "Lost in Space", folder: "Lost-in-Space",
    files: ["Chicken-LIS","Don-West","Dr.-Smith","John","Judy","Maureen","Penny","Robot","Will"] },
  { key: "love-death-robots", label: "Love, Death & Robots", folder: "Love,-Death-&-Robots",
    files: ["Golden-Woman","K-VRC","Rose","Sonnie","The-Witness","Zima-Blue"] },
  { key: "lucifer", label: "Lucifer", folder: "Lucifer",
    files: ["Amenadiel","Chloe","Dan","Ella","Linda","Lucifer","Maze","Profile-Avatar"] },
  { key: "lupin", label: "Lupin", folder: "Lupin",
    files: ["Assane-the-Gangster","Assane-the-Hat","Assane-the-Sapeur","Assane-the-Security-Guard","Assane-the-Suave-Man","Assane-the-Trash-Collector","Assane-the-businessman","Assane-the-geek","Assane-the-gentleman-thief","Assane-the-janitor","Assane-the-old-man","J’accuse","The-Black-Pearl"] },
  { key: "money-heist", label: "Money Heist", folder: "Money-Heist",
    files: ["Berlin","Denver","Lisboa","Mask","Nairobi","Palermo","Professor","Rio","Sierra","Tokio"] },
  { key: "one-piece", label: "ONE PIECE", folder: "ONE-PIECE",
    files: ["Arlong","Buggy","Chopper","Den-Den-Mushi","Garp","Going-Merry","Jolly-Roger","Koby","Luffy","Mihawk","Miss-All-Sunday","Miss-Wednesday","Nami","Sanji","Shanks","Straw-Hats-Jolly-Roger","Usopp","Zoro"] },
  { key: "oitnb", label: "Orange Is the New Black", folder: "Orange-Is-the-New-Black",
    files: ["Alex","Black-Cindy","Chicken-ONB","Daya","Gloria","Nicky","Piper","Red","Suzanne","Taystee"] },
  { key: "our-planet", label: "Our Planet", folder: "Our-Planet",
    files: ["Bird","Butterfly","Capybara","Fox","Frog","Leopard","Monkey","Orangutan","Penguin","Polar-Bear","Rhino","Shark","Tiger","Turtle"] },
  { key: "outer-banks", label: "Outer Banks", folder: "Outer-Banks",
    files: ["Cleo","JJ","John-B","Kiara","Pope","Rafe","Sarah"] },
  { key: "raw", label: "WWE Raw", folder: "Raw",
    files: ["Bianca-Belair","CM-Punk","Cody-Rhodes","John-Cena","Liv-Morgan","Rey-Mysterio","Rhea-Ripley","Roman-Reigns"] },
  { key: "sacred-games", label: "Sacred Games", folder: "Sacred-Games",
    files: ["Batya","Ganesh-Gaitonde","Guru-Ji","Mandala","Sartaj-Singh","Shahid-Khan"] },
  { key: "squid-game", label: "Squid Game", folder: "Squid-Game",
    files: ["Dalgona","Front-Man","Gi-hun-Season-2","Gi-hun","Hyun-ju","In-ho","Jun-hee","Jun-ho","Masked-Manager","Masked-Officer","Masked-Soldier","Masked-Worker","Myung-gi","No-eul","Piggy-Bank","Profile-Avatar-(1)","Profile-Avatar","Recruiter","Thanos","Young-hee"] },
  { key: "stranger-things", label: "Stranger Things", folder: "Stranger-Things",
    files: ["DEMOGORGON","DEREK","DUSTIN","Dr-KAY","ELEVEN","ERICA","HENRY","HOLLY","HOPPER","JONATHAN","JOYCE","KAREN","LUCAS","MAX","MIKE","MURRAY","NANCY","ROBIN","STEVE","VECNA","WILL"] },
  { key: "classics", label: "The Classics", folder: "The-Classics",
    files: ["Alien","Chicken","Dark-Grey-Smile","Dog","Dusty-Chilleez","Eyepatch","Green-Smile","Helmet","Moustache","Mummy","Pink-Giggle","Pink-Smile","Purple-Penguin","Purple-Smile","Purple-Superhero","Red-Smile","Red-Superhero","Robin-Chilleez","Robot","Scarlet-Chilleez","Sunny-Chilleez","Yellow-Smile"] },
  { key: "the-crown", label: "The Crown", folder: "The-Crown",
    files: ["Corgi","Lady-Diana","Prince-Charles---Dominic-West","Prince-Charles---Josh-O'Connor","Prince-Philip---Jonathan-Pryce","Prince-Phillip---Matt-Smith","Prince-Phillip---Tobias-Menzies","Princess-Diana","Princess-Margaret---Helena-Bonham-Carter","Princess-Margaret---Lesley-Manville","Princess-Margaret---Vanessa-Kirby","Queen-Elizabeth---Claire-Foy","Queen-Elizabeth---Imelda-Staunton","Queen-Elizabeth---Olivia-Coleman"] },
  { key: "umbrella-academy", label: "The Umbrella Academy", folder: "The-Umbrella-Academy",
    files: ["Allison","Ben","Diego","Five","Klaus","Luther","Pogo","Viktor"] },
  { key: "wednesday", label: "Wednesday", folder: "Wednesday",
    files: ["Profile-Avatar-(1)","Profile-Avatar-(10)","Profile-Avatar-(11)","Profile-Avatar-(12)","Profile-Avatar-(2)","Profile-Avatar-(3)","Profile-Avatar-(4)","Profile-Avatar-(5)","Profile-Avatar-(6)","Profile-Avatar-(7)","Profile-Avatar-(8)","Profile-Avatar-(9)","Profile-Avatar"] },
];

const byKey = new Map(AVATAR_CATEGORIES.map((c) => [c.key, c]));

function encodePath(folder: string, file: string): string | null {
  if (!avatarBaseUrl) return null;
  // Encode every path segment fully. Some folders contain commas, ampersands, apostrophes,
  // and spaces; partial encoding can make mobile browsers/CDNs miss the real R2 object.
  return `${avatarBaseUrl}/${encodeURIComponent(folder)}/${encodeURIComponent(file)}.png`;
}

/**
 * Resolves an avatar ID to a full image URL.
 * Supported ID format: `netflix:<categoryKey>:<fileName>`.
 * Legacy `dicebear:*` ids return null so the caller renders the letter fallback.
 */
export function resolveAvatar(avatarId?: string | null): string | null {
  if (!avatarId || typeof avatarId !== "string") return null;
  if (!avatarId.startsWith("netflix:")) return null;
  const [, key, ...rest] = avatarId.split(":");
  const file = rest.join(":");
  const cat = byKey.get(key);
  if (!cat || !file || !cat.files.includes(file)) return null;
  return encodePath(cat.folder, file);
}

export function buildAvatarId(categoryKey: string, file: string): string {
  return `netflix:${categoryKey}:${file}`;
}

export function getAvatarCategoryUrls(categoryKey: string): string[] {
  const category = byKey.get(categoryKey);
  if (!category) return [];
  return category.files.map((file) => encodePath(category.folder, file)).filter((url): url is string => !!url);
}

export const AVATAR_TOTAL = AVATAR_CATEGORIES.reduce((n, c) => n + c.files.length, 0);
