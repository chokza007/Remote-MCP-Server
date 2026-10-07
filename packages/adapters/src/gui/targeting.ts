import type {
  GuiTargetSelector,
  GuiTargetStrategy,
  ScreenRect,
  UiElement,
  WindowInfo,
  WindowSelector
} from "./window-model.js";

export class GuiTargetingError extends Error {
  public readonly code: "not_found" | "ambiguous_target" | "coordinate_fallback_denied";

  public constructor(code: GuiTargetingError["code"], message: string) {
    super(message);
    this.name = "GuiTargetingError";
    this.code = code;
  }
}

function matchesWindow(window: WindowInfo, selector: WindowSelector): boolean {
  if (selector.handle !== undefined && window.handle !== selector.handle) return false;
  if (selector.processId !== undefined && window.processId !== selector.processId) return false;
  if (selector.title !== undefined && window.title !== selector.title) return false;
  if (selector.className !== undefined && window.className !== selector.className) return false;
  if (selector.modal !== undefined && window.modal !== selector.modal) return false;
  if (selector.titleRegex !== undefined) {
    let expression: RegExp;
    try {
      expression = new RegExp(selector.titleRegex, "u");
    } catch {
      throw new GuiTargetingError("not_found", "Window title regular expression is invalid");
    }
    if (!expression.test(window.title)) return false;
  }
  return true;
}

export function selectWindow(windows: readonly WindowInfo[], selector: WindowSelector): WindowInfo {
  const candidates = windows.filter((entry) => matchesWindow(entry, selector));
  if (candidates.length === 0) throw new GuiTargetingError("not_found", "Window was not found");
  if (candidates.length > 1) {
    throw new GuiTargetingError("ambiguous_target", `Window selector matched ${candidates.length} windows`);
  }
  return candidates[0]!;
}

function matchesElement(element: UiElement, selector: GuiTargetSelector): boolean {
  if (selector.runtimeId !== undefined && element.runtimeId !== selector.runtimeId) return false;
  if (selector.automationId !== undefined && element.automationId !== selector.automationId) return false;
  if (selector.name !== undefined && element.name !== selector.name) return false;
  if (selector.controlType !== undefined && element.controlType !== selector.controlType) return false;
  return true;
}

export function selectElement(elements: readonly UiElement[], selector: GuiTargetSelector): UiElement {
  const semantic = {
    ...(selector.runtimeId === undefined ? {} : { runtimeId: selector.runtimeId }),
    ...(selector.automationId === undefined ? {} : { automationId: selector.automationId }),
    ...(selector.name === undefined ? {} : { name: selector.name }),
    ...(selector.controlType === undefined ? {} : { controlType: selector.controlType })
  };
  if (Object.keys(semantic).length === 0) {
    throw new GuiTargetingError("not_found", "A semantic element selector is required");
  }
  const candidates = elements.filter((entry) => matchesElement(entry, selector));
  if (candidates.length === 0) throw new GuiTargetingError("not_found", "UI element was not found");
  if (candidates.length > 1) {
    throw new GuiTargetingError("ambiguous_target", `Element selector matched ${candidates.length} controls`);
  }
  return candidates[0]!;
}

function relativeCoordinate(value: number, origin: number, size: number): number {
  return Math.round(origin + (Math.abs(value) <= 1 ? value * size : value));
}

export function coordinatePoint(
  bounds: ScreenRect,
  target: NonNullable<GuiTargetSelector["coordinates"]>,
  allowCoordinateFallback: boolean
): { readonly point: { readonly x: number; readonly y: number }; readonly strategy: GuiTargetStrategy } {
  if (!allowCoordinateFallback) {
    throw new GuiTargetingError("coordinate_fallback_denied", "Coordinate targeting requires explicit opt-in");
  }
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new GuiTargetingError("not_found", "Coordinates must be finite numbers");
  }
  if (target.relativeTo === "screen") {
    return {
      point: { x: Math.round(target.x), y: Math.round(target.y) },
      strategy: "absolute_coordinates"
    };
  }
  return {
    point: {
      x: relativeCoordinate(target.x, bounds.x, bounds.width),
      y: relativeCoordinate(target.y, bounds.y, bounds.height)
    },
    strategy: "window_relative_coordinates"
  };
}
