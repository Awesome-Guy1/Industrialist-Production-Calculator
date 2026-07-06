import { toBlob } from 'html-to-image';
import { getNodesBounds, type Node } from '@xyflow/react';
import type { SaveRecord } from '../types/saves';
import { useUIStore } from '../stores/useUIStore';
import { discoverThemeVariables } from '../theme/themeManager';

const MAX_CANVAS_DIMENSION = 16384;
const EXPORT_PADDING = 50;
const EXPORT_READY_FRAMES = 2;

const SVG_PRESENTATION_PROPERTIES = [
  'color',
  'fill',
  'fill-opacity',
  'opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'vector-effect',
] as const;

const EXPORT_STYLE_PROPERTIES = [
  'align-items',
  'backface-visibility',
  'background',
  'background-color',
  'border',
  'border-bottom',
  'border-bottom-color',
  'border-bottom-style',
  'border-bottom-width',
  'border-color',
  'border-left',
  'border-left-color',
  'border-left-style',
  'border-left-width',
  'border-radius',
  'border-right',
  'border-right-color',
  'border-right-style',
  'border-right-width',
  'border-style',
  'border-top',
  'border-top-color',
  'border-top-style',
  'border-top-width',
  'border-width',
  'box-sizing',
  'color',
  'contain',
  'display',
  'fill',
  'flex',
  'flex-direction',
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'gap',
  'grid-template-columns',
  'height',
  'justify-content',
  'line-height',
  'margin',
  'max-width',
  'min-height',
  'min-width',
  'opacity',
  'outline',
  'outline-color',
  'outline-offset',
  'outline-style',
  'outline-width',
  'overflow',
  'padding',
  'position',
  'stroke',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-width',
  'text-align',
  'text-overflow',
  'transform',
  'transform-origin',
  'visibility',
  'white-space',
  'width',
  'word-break',
] as const;

interface RestorableStyle {
  element: Element;
  property: string;
  value: string;
  priority: string;
}

function getThemeVariableNames(): string[] {
  const names = new Set(discoverThemeVariables().map((definition) => definition.name));

  const rootInlineStyle = document.documentElement.style;
  for (const propertyName of Array.from(rootInlineStyle)) {
    if (propertyName.startsWith('--theme-')) names.add(propertyName);
  }

  return Array.from(names);
}

function applyInlineThemeVariables(
  element: HTMLElement,
  themeVariableNames: string[],
): RestorableStyle[] {
  const rootStyle = getComputedStyle(document.documentElement);
  const previousValues: RestorableStyle[] = [];

  for (let i = 0; i < themeVariableNames.length; i++) {
    const property = themeVariableNames[i];
    const value = rootStyle.getPropertyValue(property).trim();
    if (!value) continue;

    previousValues.push({
      element,
      property,
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    });
    element.style.setProperty(property, value);
  }

  return previousValues;
}

function applyResolvedSvgStyles(root: HTMLElement): RestorableStyle[] {
  const previousValues: RestorableStyle[] = [];
  const elements = root.querySelectorAll<SVGElement>(
    'svg, g, path, line, circle, rect, ellipse, polygon, polyline, text',
  );

  for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
    const element = elements[elementIndex];
    const computedStyle = getComputedStyle(element);

    for (
      let propertyIndex = 0;
      propertyIndex < SVG_PRESENTATION_PROPERTIES.length;
      propertyIndex++
    ) {
      const property = SVG_PRESENTATION_PROPERTIES[propertyIndex];
      const value = computedStyle.getPropertyValue(property).trim();
      if (!value) continue;

      previousValues.push({
        element,
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      });
      element.style.setProperty(property, value);
    }
  }

  return previousValues;
}

function restoreStyles(previousValues: RestorableStyle[]): void {
  for (let i = previousValues.length - 1; i >= 0; i--) {
    const { element, property, value, priority } = previousValues[i];
    if (value) {
      (element as HTMLElement | SVGElement).style.setProperty(property, value, priority);
    } else {
      (element as HTMLElement | SVGElement).style.removeProperty(property);
    }
  }
}

function getExportStyleProperties(themeVariableNames: string[]): string[] {
  return Array.from(
    new Set([...EXPORT_STYLE_PROPERTIES, ...SVG_PRESENTATION_PROPERTIES, ...themeVariableNames]),
  );
}

async function waitForExportReady(): Promise<void> {
  for (let i = 0; i < EXPORT_READY_FRAMES; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

export function exportRecordAsJson(record: SaveRecord): void {
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = `${record.name.replace(/\s+/g, '_')}_save.json`;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

export async function exportCanvasAsPng(nodes: Node[]): Promise<void> {
  const viewportElement = document.querySelector('.react-flow__viewport') as HTMLElement | null;
  if (!viewportElement || nodes.length === 0) {
    throw new Error('No elements or nodes found for PNG export');
  }

  const themeBg = getComputedStyle(document.documentElement)
    .getPropertyValue('--theme-color-canvas-bg')
    .trim();

  if (!themeBg) {
    throw new Error(
      'Required theme variable --theme-color-canvas-bg is not defined on document.documentElement',
    );
  }

  const nodeLookup = new Map(nodes.map((node) => [node.id, node])) as unknown as Parameters<
    typeof getNodesBounds
  >[1] extends { nodeLookup?: infer L }
    ? L
    : never;
  const bounds = getNodesBounds(nodes, { nodeLookup });

  const naturalWidth = bounds.width + EXPORT_PADDING * 2;
  const naturalHeight = bounds.height + EXPORT_PADDING * 2;

  const scale = Math.min(
    1,
    MAX_CANVAS_DIMENSION / naturalWidth,
    MAX_CANVAS_DIMENSION / naturalHeight,
  );
  const exportWidth = Math.round(naturalWidth * scale);
  const exportHeight = Math.round(naturalHeight * scale);

  const uiStore = useUIStore.getState();
  uiStore.setIsExporting(true);

  try {
    await waitForExportReady();

    const themeVariableNames = getThemeVariableNames();
    const restoredStyles = [
      ...applyInlineThemeVariables(viewportElement, themeVariableNames),
      ...applyResolvedSvgStyles(viewportElement),
    ];

    let blob: Blob | null;
    try {
      blob = await toBlob(viewportElement, {
        backgroundColor: themeBg,
        width: exportWidth,
        height: exportHeight,
        includeStyleProperties: getExportStyleProperties(themeVariableNames),
        pixelRatio: 1,
        style: {
          width: `${naturalWidth}px`,
          height: `${naturalHeight}px`,
          transform: `translate(${-bounds.x + EXPORT_PADDING}px, ${-bounds.y + EXPORT_PADDING}px) scale(${scale})`,
          transformOrigin: 'top left',
        },
      });
    } finally {
      restoreStyles(restoredStyles);
    }
    if (!blob) {
      throw new Error('PNG export failed: toBlob returned null');
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `industrialist-canvas-${Date.now()}.png`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  } finally {
    uiStore.setIsExporting(false);
  }
}
