export type PlaceholderNormalizeResult = {
  text: string;
  unknownPlaceholders: string[];
};

const PLACEHOLDER_ALIASES: Record<string, string> = {
  crm: "crm",
  chat: "chat",
  email: "email",
  docs: "docs",
  enrichment: "enrichment",
  tracker: "tracker",
  analytics: "analytics",
  design: "design",
  calls: "calls",
  "product analytics": "analytics",
  "seo tools": "seo",
  seo: "seo",
};

const PLACEHOLDER_ALIAS_ENTRIES = Object.entries(PLACEHOLDER_ALIASES).map(([alias, canonical]) => ({
  alias,
  canonical,
  words: alias.split(" "),
}));

const PLACEHOLDER_ALIAS_LOOKUP = new Map(
  PLACEHOLDER_ALIAS_ENTRIES.map(({ alias, canonical }) => [alias, canonical]),
);
const PLACEHOLDER_ALIAS_PREFIXES = new Set<string>();

for (const { words } of PLACEHOLDER_ALIAS_ENTRIES) {
  for (let i = 1; i < words.length; i += 1) {
    PLACEHOLDER_ALIAS_PREFIXES.add(words.slice(0, i).join(" "));
  }
}

const MAX_PLACEHOLDER_WORDS = PLACEHOLDER_ALIAS_ENTRIES.reduce(
  (max, entry) => Math.max(max, entry.words.length),
  1,
);

function canonicalizePlaceholder(raw: string): string | null {
  const normalized = raw.toLowerCase().trim().replace(/\s+/g, " ");
  return PLACEHOLDER_ALIASES[normalized] ?? null;
}

function readWord(input: string, startIndex: number): { value: string; endIndex: number } | null {
  let endIndex = startIndex;
  while (endIndex < input.length && /[a-z0-9]/i.test(input[endIndex])) {
    endIndex += 1;
  }

  if (endIndex === startIndex) {
    return null;
  }

  return { value: input.slice(startIndex, endIndex), endIndex };
}

function skipSpaces(input: string, startIndex: number): number {
  let index = startIndex;
  while (index < input.length && input[index] === " ") {
    index += 1;
  }
  return index;
}

function readPlaceholderToken(
  input: string,
  startIndex: number,
): { raw: string; endIndex: number } | null {
  if (!input.startsWith("~~", startIndex)) {
    return null;
  }

  const firstWord = readWord(input, startIndex + 2);
  if (!firstWord) {
    return null;
  }

  const words = [firstWord.value];
  let phrase = firstWord.value.toLowerCase();
  let scanIndex = skipSpaces(input, firstWord.endIndex);
  let bestEndIndex = firstWord.endIndex;
  let bestCanonical = PLACEHOLDER_ALIAS_LOOKUP.get(phrase) ?? null;

  for (let wordCount = 1; wordCount < MAX_PLACEHOLDER_WORDS; wordCount += 1) {
    if (scanIndex >= input.length) {
      break;
    }

    const nextWord = readWord(input, scanIndex);
    if (!nextWord) {
      break;
    }

    const nextPhrase = `${phrase} ${nextWord.value.toLowerCase()}`;
    const isExactAlias = PLACEHOLDER_ALIAS_LOOKUP.has(nextPhrase);
    const isAliasPrefix = PLACEHOLDER_ALIAS_PREFIXES.has(nextPhrase);
    if (!isExactAlias && !isAliasPrefix) {
      break;
    }

    words.push(nextWord.value);
    phrase = nextPhrase;
    scanIndex = skipSpaces(input, nextWord.endIndex);

    if (isExactAlias) {
      bestEndIndex = nextWord.endIndex;
      bestCanonical = PLACEHOLDER_ALIAS_LOOKUP.get(nextPhrase) ?? bestCanonical;
    }
  }

  if (bestCanonical) {
    return {
      raw: input.slice(startIndex, bestEndIndex),
      endIndex: bestEndIndex,
    };
  }

  return {
    raw: `~~${words[0]}`,
    endIndex: firstWord.endIndex,
  };
}

export function normalizePlaceholders(input: string): PlaceholderNormalizeResult {
  const unknownPlaceholders: string[] = [];
  const seenUnknown = new Set<string>();

  let text = "";
  let index = 0;

  while (index < input.length) {
    const placeholder = readPlaceholderToken(input, index);
    if (!placeholder) {
      text += input[index];
      index += 1;
      continue;
    }

    const canonical = canonicalizePlaceholder(placeholder.raw.slice(2));
    if (canonical) {
      text += `~~${canonical}`;
    } else {
      if (!seenUnknown.has(placeholder.raw)) {
        seenUnknown.add(placeholder.raw);
        unknownPlaceholders.push(placeholder.raw);
      }
      text += placeholder.raw;
    }

    index = placeholder.endIndex;
  }

  return { text, unknownPlaceholders };
}
