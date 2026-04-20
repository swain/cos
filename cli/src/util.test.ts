import { describe, expect, it } from "vitest";
import { appendGoogleAuthUser } from "./util.js";

describe("appendGoogleAuthUser", () => {
  it("adds authuser=1 to meet.google.com with no query string", () => {
    expect(appendGoogleAuthUser("https://meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij?authuser=1",
    );
  });

  it("adds authuser=1 using & when URL already has a query string", () => {
    expect(
      appendGoogleAuthUser("https://calendar.google.com/calendar/event?eid=X"),
    ).toBe("https://calendar.google.com/calendar/event?eid=X&authuser=1");
  });

  it("leaves URL alone when authuser is already present", () => {
    const url = "https://meet.google.com/abc-defg-hij?authuser=0";
    expect(appendGoogleAuthUser(url)).toBe(url);
  });

  it("annotates docs.google.com URLs", () => {
    expect(
      appendGoogleAuthUser("https://docs.google.com/document/d/XYZ/edit"),
    ).toBe("https://docs.google.com/document/d/XYZ/edit?authuser=1");
  });

  it("annotates hangouts.google.com URLs", () => {
    expect(appendGoogleAuthUser("https://hangouts.google.com/call/abc")).toBe(
      "https://hangouts.google.com/call/abc?authuser=1",
    );
  });

  it("leaves non-Google URLs untouched", () => {
    const url = "https://example.com/path?x=1";
    expect(appendGoogleAuthUser(url)).toBe(url);
  });

  it("leaves www.google.com URLs untouched (not in host allowlist)", () => {
    const url = "https://www.google.com/search?q=meet";
    expect(appendGoogleAuthUser(url)).toBe(url);
  });

  it("returns unparseable input unchanged", () => {
    expect(appendGoogleAuthUser("not a url")).toBe("not a url");
  });

  it("preserves url fragments", () => {
    expect(
      appendGoogleAuthUser("https://docs.google.com/document/d/X/edit#heading"),
    ).toBe("https://docs.google.com/document/d/X/edit?authuser=1#heading");
  });
});
