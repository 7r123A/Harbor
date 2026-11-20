import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { JSDOM } from "jsdom";
import { colorContrast, mixHex, readablePalette } from "@/lib/color-contrast";
import { profileCardStyle } from "@/lib/social/profile-card-appearance";
import { profileThemeScope, withProfileTheme } from "@/lib/profile-theme";
import { ProfileThemePicker } from "@/views/profile/profile-theme-picker";
import type { ProfileSummary } from "@/views/profile/profile-types";

function assertReadable(backgrounds: string[], colors: string[]) {
  for (const color of colors)
    for (const from of backgrounds)
      for (const to of backgrounds)
        for (let i = 0; i <= 16; i++) {
          const background = mixHex(from, to, i / 16);
          assert.ok(
            colorContrast(color, background) >= 4.5,
            `${color} against ${background} must remain readable`,
          );
        }
}

test("text protection preserves readable choices and replaces hidden text on light, dark and mixed gradients", () => {
  for (const stops of [
    ["#ffffff", "#ffffff"],
    ["#000000", "#000000"],
    ["#000000", "#ffffff"],
    ["#ff0000", "#00ff00"],
    ["#22d3ee", "#4f46e5"],
  ]) {
    const safe = readablePalette(
      { from: stops[0], to: stops[1] },
      { name: stops[0], handle: stops[1], other: "#777777" },
    );
    assertReadable(Object.values(safe.backgrounds), Object.values(safe.text));
  }
  assert.equal(readablePalette({ surface: "#ffffff" }, { name: "#123456" }).text.name, "#123456");
});

test("essential card text is protected even when old saved colors equal the card theme", () => {
  for (const [from, to] of [
    ["#ffffff", "#ffffff"],
    ["#111111", "#111111"],
    ["#000000", "#ffffff"],
  ]) {
    const style = profileCardStyle({
      theme: "custom",
      gradient: "",
      from,
      to,
      accent: null,
      nameColor: from,
      handleColor: to,
      textColor: from,
      bioColor: "#abcdef",
      bgUrl: null,
      bgKind: null,
      customised: true,
    }) as Record<string, string>;
    const colors = [
      style["--profile-card-name"],
      style["--profile-card-handle"],
      style["--color-ink"],
      style["--color-ink-subtle"],
    ];
    const first = /#[0-9a-f]{6}/i.exec(style.backgroundImage)![0];
    assertReadable(
      [
        first,
        style["--color-canvas"],
        style["--color-surface"],
        style["--color-elevated"],
        style["--color-raised"],
      ],
      colors,
    );
    assert.equal(style["--profile-card-bio"], "#abcdef");
  }
});

test("profile theme fallback protects main, secondary and accent text against custom backgrounds", () => {
  for (const [canvas, surface] of [
    ["#ffffff", "#ffffff"],
    ["#111111", "#111111"],
    ["#000000", "#ffffff"],
  ]) {
    const scope = profileThemeScope({
      palette: "custom",
      glass: false,
      gradient: true,
      colors: { canvas, surface, ink: canvas, accent: surface },
    });
    assertReadable(
      [
        "--color-canvas",
        "--color-surface",
        "--color-elevated",
        "--color-raised",
        "--profile-wash-color",
      ].map((key) => scope.vars[key]),
      ["--color-ink", "--color-ink-muted", "--color-ink-subtle", "--color-accent"].map(
        (key) => scope.vars[key],
      ),
    );
  }
});

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
    const preview = document.querySelector('section[aria-label="Profile theme live preview"]')!;
    assert.match(preview.textContent!, /Preview Fixture/);
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
    assert.equal(
      (preview.querySelector("[data-profile-ui]") as HTMLElement).style.getPropertyValue(
        "--color-canvas",
      ),
      "#303030",
    );
    assert.equal(writes, 0, "editing preview must not save the draft");
    const paper = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Paper"),
    )!;
    await React.act(() => paper.click());
    assert.equal(writes, 1);
    assert.equal(
      (preview.querySelector("[data-profile-ui]") as HTMLElement).style.colorScheme,
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
