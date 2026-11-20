/** Readability guards for owner-selected colors on profile and card surfaces. */
const HEX = /^#[0-9a-f]{6}$/i;
export function mixHex(a: string, b: string, amount: number): string {
  return (
    "#" +
    [1, 3, 5]
      .map((index) =>
        Math.round(
          parseInt(a.slice(index, index + 2), 16) * (1 - amount) +
            parseInt(b.slice(index, index + 2), 16) * amount,
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
function luminance(hex: string): number {
  const values = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
export function colorContrast(a: string, b: string): number {
  const first = luminance(a),
    second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
export function readablePalette(
  backgrounds: Record<string, string>,
  text: Record<string, string | null | undefined>,
) {
  let surfaces = { ...backgrounds };
  const samples = (colors: Record<string, string>) => {
    const values = Object.values(colors);
    const result = [...values];
    for (let i = 0; i < values.length; i++)
      for (let j = i + 1; j < values.length; j++)
        for (let step = 1; step < 16; step++) result.push(mixHex(values[i], values[j], step / 16));
    return result;
  };
  const minimum = (color: string, colors: string[]) =>
    Math.min(...colors.map((background) => colorContrast(color, background)));
  let colors = samples(surfaces);
  // A gradient spanning light and dark may have no readable single foreground.
  // Shade it just enough to provide a consistent foreground across the whole range.
  if (Math.max(minimum("#ffffff", colors), minimum("#000000", colors)) < 4.5) {
    let low = 0,
      high = 1;
    for (let i = 0; i < 12; i++) {
      const middle = (low + high) / 2;
      const candidate = Object.fromEntries(
        Object.entries(backgrounds).map(([key, value]) => [key, mixHex(value, "#000000", middle)]),
      );
      if (minimum("#ffffff", samples(candidate)) >= 4.6) high = middle;
      else low = middle;
    }
    surfaces = Object.fromEntries(
      Object.entries(backgrounds).map(([key, value]) => [key, mixHex(value, "#000000", high)]),
    );
    colors = samples(surfaces);
  }
  const fallback = minimum("#ffffff", colors) >= minimum("#000000", colors) ? "#ffffff" : "#000000";
  const foregrounds = Object.fromEntries(
    Object.entries(text).map(([key, value]) => [
      key,
      value && HEX.test(value) && minimum(value, colors) >= 4.5 ? value : fallback,
    ]),
  );
  return { backgrounds: surfaces, text: foregrounds };
}
