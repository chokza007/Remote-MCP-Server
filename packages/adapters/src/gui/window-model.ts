export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopInfo {
  readonly name: string;
  readonly interactive: boolean;
}

export interface WindowInfo {
  readonly handle: string;
  readonly processId: number;
  readonly title: string;
  readonly className: string;
  readonly bounds: ScreenRect;
  readonly dpi: number;
  readonly focused: boolean;
  readonly modal: boolean;
}

export interface WindowSelector {
  readonly handle?: string;
  readonly processId?: number;
  readonly title?: string;
  readonly titleRegex?: string;
  readonly className?: string;
  readonly modal?: boolean;
}

export interface ElementSelector {
  readonly runtimeId?: string;
  readonly automationId?: string;
  readonly name?: string;
  readonly controlType?: string;
}

export interface CoordinateTarget {
  readonly x: number;
  readonly y: number;
  readonly relativeTo: "window" | "screen";
}

export interface GuiTargetSelector extends ElementSelector {
  readonly coordinates?: CoordinateTarget;
}

export interface UiElement {
  readonly runtimeId: string;
  readonly windowHandle: string;
  readonly automationId: string;
  readonly name: string;
  readonly controlType: string;
  readonly bounds: ScreenRect;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly password: boolean;
  readonly patterns: readonly string[];
}

export type GuiTargetStrategy =
  | "application_api"
  | "uia_semantic"
  | "window_relative_coordinates"
  | "absolute_coordinates";

export interface GuiEvidence {
  readonly kind: string;
  readonly verified: boolean;
  readonly operation?: string;
  readonly windowHandle?: string;
  readonly focusedWindowHandle?: string;
  readonly runtimeId?: string;
  readonly value?: unknown;
  readonly [key: string]: unknown;
}

export interface GuiActionResult {
  readonly status: "completed";
  readonly strategy: GuiTargetStrategy;
  readonly attempts: number;
  readonly evidence: GuiEvidence;
}

export interface GuiCaptureResult {
  readonly status: "completed";
  readonly path: string;
  readonly mediaType: "image/png";
  readonly sha256: string;
  readonly size: number;
  readonly evidence: GuiEvidence;
}
