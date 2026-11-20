import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { JSDOM } from "jsdom";
import { profileThemeScope, withProfileTheme } from "@/lib/profile-theme";
import { profileCardStyle } from "@/lib/social/profile-card-appearance";
import { ProfileThemePicker } from "@/views/profile/profile-theme-picker";
import type { ProfileSummary } from "@/views/profile/profile-types";

test("profile theme preview changes while saving and while editing an unsaved custom color", async (t) => {
  const dom = new JSDOM("<div id='root'></div>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const colors = { canvas: "#111111", surface: "#222222", ink: "#eeeeee", accent: "#eebb33" };
  const summary = {
    handle: "theme-preview",
    alias: "Preview Fixture",
    slogan: "Preview bio",
    customCss: withProfileTheme("", { palette: "custom", glass: false, gradient: false, colors }),
  } as ProfileSummary;
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  t.mock.method(globalThis, "fetch", async () => {
    writes++;
    return pending;
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(() => root.render(<ProfileThemePicker summary={summary} onSaved={() => {}} />));
    const preview = document.querySelector('section[aria-label="Profile appearance"]')!;
    assert.match(preview.textContent!, /Preview Fixture/);
    assert.ok(!document.body.textContent?.includes("Live preview"));
    const preset = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Paper"),
    )!;
    assert.ok(
      preview.compareDocumentPosition(preset) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const input = document.querySelector('input[aria-label="Background"]') as HTMLInputElement;
    await React.act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "#303030");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal((preview as HTMLElement).style.getPropertyValue("--color-canvas"), "#303030");
    assert.equal(writes, 0, "editing preview must not save the draft");
    const paper = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Paper"),
    )!;
    await React.act(() => paper.click());
    assert.equal(writes, 1);
    assert.equal(
      (preview as HTMLElement).style.colorScheme,
      "light",
      "preview updates before the save completes",
    );
    await React.act(async () => {
      release(Response.json(summary));
    });
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
  }
});

test("card and profile themes use chosen colors without automatic contrast correction", () => {
  const style = profileCardStyle({
    theme: "custom",
    from: "#ffffff",
    to: "#ffffff",
    gradient: "",
    accent: null,
    nameColor: "#ffffff",
    handleColor: "#ffffff",
    textColor: "#ffffff",
    bioColor: "#ffffff",
    bgUrl: null,
    bgKind: null,
    customised: true,
  }) as Record<string, string>;
  assert.equal(style["--profile-card-name"], "#ffffff");
  assert.equal(style["--profile-card-handle"], "#ffffff");
  assert.equal(style["--color-ink"], "#ffffff");
  assert.equal(style.backgroundImage, "linear-gradient(135deg, #ffffff, #ffffff)");
  const scope = profileThemeScope({
    palette: "custom",
    glass: false,
    gradient: false,
    colors: { canvas: "#ffffff", surface: "#ffffff", ink: "#ffffff", accent: "#ffffff" },
  });
  assert.equal(scope.vars["--color-ink"], "#ffffff");
  assert.equal(scope.vars["--color-canvas"], "#ffffff");
  assert.equal(scope.vars["--color-accent"], "#ffffff");
});
