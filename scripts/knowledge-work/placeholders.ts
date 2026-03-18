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

function canonicalizePlaceholder(raw: string): string | null {
  const normalized = raw.toLowerCase().trim().replace(/\s+/g, " ");
  return PLACEHOLDER_ALIASES[normalized] ?? null;
}

function shouldTreatAsPlaceholder(token: string): boolean {
  return token.length > 2 && /^[a-z0-9][a-z0-9 ]*$/i.test(token);
}

export function normalizePlaceholders(input: string): PlaceholderNormalizeResult {
  const unknownPlaceholders: string[] = [];
  const seenUnknown = new Set<string>();

  const text = input.replace(/~~([a-z0-9][a-z0-9 ]*)/gi, (match, token: string) => {
    if (!shouldTreatAsPlaceholder(token)) {
      return match;
    }

    const canonical = canonicalizePlaceholder(token);
    if (canonical) {
      return `~~${canonical}`;
    }

    if (!seenUnknown.has(match)) {
      seenUnknown.add(match);
      unknownPlaceholders.push(match);
    }
    return match;
  });

  return { text, unknownPlaceholders };
}
