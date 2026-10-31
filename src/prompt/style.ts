import type { Color, SegmentStyle } from "./types";

const namedColors: Readonly<Record<string, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  purple: 35,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  "bright-black": 90,
  "bright-red": 91,
  "bright-green": 92,
  "bright-yellow": 93,
  "bright-blue": 94,
  "bright-purple": 95,
  "bright-magenta": 95,
  "bright-cyan": 96,
  "bright-white": 97,
};

export interface StyleEnvironment {
  readonly noColor?: boolean;
  readonly trueColor?: boolean;
}

function colorCode(
  color: Color,
  palette: Readonly<Record<string, Color>>,
  env: StyleEnvironment,
): string | undefined {
  if (typeof color === "number") return `38;5;${Math.max(0, Math.min(255, color))}`;
  const resolved = palette[color] ?? color;
  if (typeof resolved === "number") return `38;5;${Math.max(0, Math.min(255, resolved))}`;
  const named = namedColors[resolved];
  if (named !== undefined) return String(named);
  const match = /^#([0-9a-f]{6})$/i.exec(resolved);
  if (!match) return undefined;
  if (!env.trueColor) return `38;5;${rgbToAnsi256(match[1])}`;
  const value = Number.parseInt(match[1], 16);
  return `38;2;${value >> 16};${(value >> 8) & 255};${value & 255}`;
}

function rgbToAnsi256(hex: string): number {
  const value = Number.parseInt(hex, 16);
  const red = value >> 16;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  const cube = (component: number) => Math.round((component / 255) * 5);
  return 16 + cube(red) * 36 + cube(green) * 6 + cube(blue);
}

export function styleKey(style: SegmentStyle | undefined): string {
  if (!style) return "";
  return JSON.stringify(style);
}

export function styleToSgr(
  style: SegmentStyle | undefined,
  palette: Readonly<Record<string, Color>>,
  environment: StyleEnvironment,
): string {
  if (!style || environment.noColor) return "";
  const codes: string[] = [];
  if (style.bold) codes.push("1");
  if (style.dim) codes.push("2");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.inverse) codes.push("7");
  if (style.strike) codes.push("9");
  const foreground = style.fg === undefined ? undefined : colorCode(style.fg, palette, environment);
  const background =
    style.bg === undefined
      ? undefined
      : colorCode(style.bg, palette, environment)?.replace(/^38;/, "48;");
  if (foreground) codes.push(foreground);
  if (background) codes.push(background);
  return codes.length ? `\u001b[${codes.join(";")}m` : "";
}
