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

  it("preserves unknown multi-word placeholders in diagnostics", () => {
    expect(normalizePlaceholders("Use ~~marketing ops.")).toEqual({
      text: "Use ~~marketing ops.",
      unknownPlaceholders: ["~~marketing ops"],
    });
  });

  it("stops unknown placeholder capture before a connector and next placeholder", () => {
    expect(normalizePlaceholders("Use ~~marketing ops and ~~seo tools.")).toEqual({
      text: "Use ~~marketing ops and ~~seo.",
      unknownPlaceholders: ["~~marketing ops"],
    });
  });

  it("normalizes placeholders embedded in prose without consuming surrounding words", () => {
    expect(normalizePlaceholders("Does ~~crm things with ~~chat.")).toEqual({
      text: "Does ~~crm things with ~~chat.",
      unknownPlaceholders: [],
    });
  });
});
