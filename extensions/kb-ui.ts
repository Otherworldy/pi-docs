import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { KbSelectOption, KbUi } from "../lib/kb.ts";

const overlay = {
  overlay: true as const,
  overlayOptions: { anchor: "center" as const, width: 76, minWidth: 48, maxHeight: "75%" as const },
};

type Item = { value: string; label: string; description?: string };

function asItems(options: KbSelectOption[]): Item[] {
  return options.map((o) => (
    typeof o === "string" ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value, description: o.description }
  ));
}

function padLine(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w === width) return text;
  if (w > width) return truncateToWidth(text, width);
  return `${text}${" ".repeat(width - w)}`;
}

function frame(lines: string[], width: number, paint: (s: string) => string): string[] {
  const inner = Math.max(8, width - 2);
  const bar = "─".repeat(inner);
  return [
    paint(`┌${bar}┐`),
    ...lines.map((line) => `${paint("│")}${padLine(line, inner)}${paint("│")}`),
    paint(`└${bar}┘`),
  ];
}

function boxedSelect(title: string, options: KbSelectOption[], tui: TUI, theme: Theme, done: (v: string | undefined) => void) {
  const items = asItems(options);
  let selected = 0;
  let pressed: number | undefined;
  const paint = (s: string) => theme.fg("borderAccent", s);
  const muted = (s: string) => theme.fg("muted", s);
  const hint = theme.fg("dim", "↑↓ 回车 点击  ·  Esc 关闭");
  const split = items.some((i) => i.description);

  function cols(inner: number) {
    if (!split) return { left: inner, right: 0 };
    const left = Math.max(12, Math.floor(inner * 0.7));
    return { left, right: Math.max(inner - left - 3, 8) };
  }

  function body(inner: number): string[] {
    const { left, right } = cols(inner);
    const leftCol: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const on = i === selected;
      const prefix = on ? "→ " : "  ";
      const label = on ? theme.fg("accent", theme.bold(item.label)) : theme.fg("text", item.label);
      leftCol.push(truncateToWidth(prefix + label, left || inner));
      leftCol.push("");
    }
    if (!right) return ["", ...leftCol];
    const desc = items[selected]?.description ?? "";
    const rightCol = wrapTextWithAnsi(muted(desc), right);
    const rows = Math.max(leftCol.length, rightCol.length, 1);
    const out = [""];
    const div = paint("│");
    for (let r = 0; r < rows; r++) {
      out.push(`${padLine(leftCol[r] ?? "", left)} ${div} ${padLine(rightCol[r] ?? "", right)}`);
    }
    return out;
  }

  function indexAt(y: number, x: number, inner: number): number | undefined {
    if (y < 1) return;
    const { left, right } = cols(inner);
    if (right && x >= left + 1) return;
    const i = Math.floor((y - 1) / 2);
    if (i >= 0 && i < items.length) return i;
  }

  return {
    render(width: number) {
      const inner = Math.max(8, width - 2);
      const head = theme.fg("accent", theme.bold(title));
      return frame([head, ...body(inner), hint], width, paint);
    },
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, Key.up) || data === "k") selected = selected === 0 ? items.length - 1 : selected - 1;
      else if (matchesKey(data, Key.down) || data === "j") selected = selected === items.length - 1 ? 0 : selected + 1;
      else if (matchesKey(data, Key.enter) || data === "\n") {
        const item = items[selected];
        if (item) done(item.value);
        return;
      } else if (matchesKey(data, Key.escape)) {
        done(undefined);
        return;
      }
      tui.requestRender();
    },
    handleMouse(event: { y: number; x: number; width: number; type: string; button?: string; wheelDelta?: number }) {
      const inner = Math.max(8, event.width - 2);
      const y = event.y - 2;
      const x = event.x - 1;
      if (event.type === "wheel" && event.wheelDelta) {
        selected = Math.max(0, Math.min(items.length - 1, selected + (event.wheelDelta < 0 ? -1 : 1)));
        tui.requestRender();
        return { handled: true };
      }
      if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) {
        return y < 0 ? { handled: true } : undefined;
      }
      const idx = indexAt(y, x, inner);
      if (idx === undefined) return { handled: true };
      if (event.type === "press") {
        pressed = idx;
        selected = idx;
        tui.requestRender();
        return { handled: true, focus: true };
      }
      const hit = pressed ?? idx;
      pressed = undefined;
      selected = hit;
      const item = items[selected];
      if (item) done(item.value);
      return { handled: true };
    },
  };
}

function boxedInput(title: string, placeholder: string | undefined, tui: TUI, theme: Theme, done: (v: string | undefined) => void) {
  const input = new Input({
    prompt: "> ",
    placeholder: placeholder ?? "",
    placeholderStyle: (t) => theme.fg("dim", t),
  });
  if (placeholder) input.setValue(placeholder);
  input.onSubmit = (value) => done(value);
  input.onEscape = () => done(undefined);
  const hint = theme.fg("dim", "回车确认  ·  Esc 取消");
  const paint = (s: string) => theme.fg("borderAccent", s);
  return {
    get focused() {
      return input.focused;
    },
    set focused(value: boolean) {
      input.focused = value;
    },
    render(width: number) {
      const inner = Math.max(8, width - 2);
      const head = theme.fg("accent", theme.bold(title));
      return frame([head, "", ...input.render(inner), "", hint], width, paint);
    },
    invalidate() {
      input.invalidate();
    },
    handleInput(data: string) {
      input.handleInput(data);
      tui.requestRender();
    },
    handleMouse(event: { y: number; x: number; width: number }) {
      const innerW = Math.max(8, event.width - 2);
      const y = event.y - 3;
      if (y < 0) return { handled: true };
      const result = input.handleMouse({ ...event, y, x: Math.max(0, event.x - 1), width: innerW } as never);
      if (result) tui.requestRender();
      return result ?? { handled: true };
    },
  };
}

export function overlayKbUi(ui: ExtensionUIContext): KbUi {
  return {
    notify(text, level) {
      ui.notify(text, level);
    },
    async select(title, options) {
      const items = asItems(options);
      if (typeof ui.custom === "function") {
        return ui.custom((tui, theme, _kb, done) => boxedSelect(title, options, tui, theme, done), overlay);
      }
      const labels = items.map((i) => i.label);
      const picked = await ui.select(title, labels);
      if (!picked) return;
      return items.find((i) => i.label === picked)?.value;
    },
    input(title, placeholder) {
      if (typeof ui.custom === "function") {
        return ui.custom((tui, theme, _kb, done) => boxedInput(title, placeholder, tui, theme, done), overlay);
      }
      return ui.input(title, placeholder);
    },
    async confirm(title, message) {
      if (typeof ui.custom === "function") {
        const pick = await ui.custom(
          (tui, theme, _kb, done) => boxedSelect(`${title}  ${message}`, ["确认", "取消"], tui, theme, done),
          overlay,
        );
        return pick === "确认";
      }
      return ui.confirm(title, message);
    },
  };
}
