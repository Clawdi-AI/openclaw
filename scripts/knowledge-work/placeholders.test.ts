import { describe, expect, it } from "vitest";
import { normalizePlaceholders } from "./placeholders.js";

describe("normalizePlaceholders", () => {
  it("keeps canonical placeholder values unchanged", () => {
    expect(normalizePlaceholders("~~crm")).toEqual({
      text: "~~crm",
      unknownPlaceholders: [],
    });
  });

  it("normalizes placeholder case", () => {
    expect(normalizePlaceholders("~~CRM")).toEqual({
      text: "~~crm",
      unknownPlaceholders: [],
    });
  });

  it("normalizes multi-word placeholder phrases", () => {
    expect(normalizePlaceholders("~~product analytics")).toEqual({
      text: "~~analytics",
      unknownPlaceholders: [],
    });
  });

  it("cleans up placeholder phrases to canonical keys", () => {
    expect(normalizePlaceholders("~~SEO tools")).toEqual({
      text: "~~seo",
      unknownPlaceholders: [],
    });
  });

  it("leaves non-placeholder text unchanged", () => {
    expect(normalizePlaceholders("no placeholders here")).toEqual({
      text: "no placeholders here",
      unknownPlaceholders: [],
    });
  });

  it("returns unknown placeholders unchanged and records them", () => {
    expect(normalizePlaceholders("~~mystery")).toEqual({
      text: "~~mystery",
      unknownPlaceholders: ["~~mystery"],
    });
  });
});
