import type { Edge } from '@xyflow/react';
import type { CanvasNode } from '../types/nodes';
import { applyLayoutResult } from './apply';
import { DEFAULT_LAYOUT_OPTIONS } from './constants';
import { runElkLayoutPass } from './elk';
import { buildLayoutEdges, buildLayoutNodes } from './layoutGraphBuilder';
import { collectLayoutedPortOrders, materializeLayoutPass } from './materialize';
import {
  arePortOrdersEqual,
  collectRefinedPortOrders,
  scorePortOrders,
} from './portOrderRefinement';
import { buildLayoutGraphResult } from './resultBuilder';
import type {
  AutoLayoutOptions,
  LayoutEdgeSpec,
  LayoutGraphResult,
  LayoutNodeSpec,
  ResolvedLayoutOptions,
} from './types';

function applyPortOrders(
  layoutNodes: LayoutNodeSpec[],
  inputOrders: Map<string, number[]>,
  outputOrders: Map<string, number[]>,
): LayoutNodeSpec[] {
  return layoutNodes.map((node) => {
    if (!node.commitPortOrder) return node;

    const inputOrder = inputOrders.get(node.id) ?? node.inputOrder;
    const outputOrder = outputOrders.get(node.id) ?? node.outputOrder;
    if (
      arePortOrdersEqual(inputOrder, node.inputOrder) &&
      arePortOrdersEqual(outputOrder, node.outputOrder)
    ) {
      return node;
    }

    return {
      ...node,
      inputOrder,
      outputOrder,
    };
  });
}

async function layoutGraph(
  layoutNodes: LayoutNodeSpec[],
  layoutEdges: LayoutEdgeSpec[],
  edgePath: NonNullable<AutoLayoutOptions['edgePath']>,
  options: ResolvedLayoutOptions,
): Promise<LayoutGraphResult> {
  if (layoutNodes.length === 0) {
    return {
      positions: new Map(),
      dimensions: new Map(),
      inputOrders: new Map(),
      outputOrders: new Map(),
      edgeUpdates: new Map(),
    };
  }

  const orderingLayouted = await runElkLayoutPass(
    layoutNodes,
    layoutEdges,
    edgePath,
    options,
    'FIXED_SIDE',
    'stable',
  );
  const orderPass = collectLayoutedPortOrders(layoutNodes, orderingLayouted);
  const orderedLayoutNodes = applyPortOrders(
    layoutNodes,
    orderPass.inputOrders,
    orderPass.outputOrders,
  );

  const layouted = await runElkLayoutPass(
    orderedLayoutNodes,
    layoutEdges,
    edgePath,
    options,
    'FIXED_POS',
    'current',
  );
  let activePass = materializeLayoutPass(orderedLayoutNodes, layouted);
  let activeScore = scorePortOrders(activePass, layoutEdges);

  for (let i = 0; i < options.portOrderRefinementPasses; i++) {
    const refinement = collectRefinedPortOrders(activePass, layoutEdges);
    if (!refinement.changed) break;

    const refinedLayoutNodes = applyPortOrders(
      activePass.layoutNodes,
      refinement.inputOrders,
      refinement.outputOrders,
    );
    const refinedLayouted = await runElkLayoutPass(
      refinedLayoutNodes,
      layoutEdges,
      edgePath,
      options,
      'FIXED_POS',
      'current',
    );
    const refinedPass = materializeLayoutPass(refinedLayoutNodes, refinedLayouted);
    const refinedScore = scorePortOrders(refinedPass, layoutEdges);

    if (refinedScore >= activeScore) break;
    activePass = refinedPass;
    activeScore = refinedScore;
  }

  return buildLayoutGraphResult(activePass, layoutEdges, edgePath);
}

export async function autoLayout(
  nodes: CanvasNode[],
  edges: Edge[],
  options: AutoLayoutOptions = {},
): Promise<{ nodes: CanvasNode[]; edges: Edge[] }> {
  if (!nodes || nodes.length === 0) {
    return { nodes, edges };
  }

  const edgePath = options.edgePath ?? 'orthogonal';
  const layoutOptions = DEFAULT_LAYOUT_OPTIONS;
  const layoutNodes = buildLayoutNodes(nodes, options.resolveRecipe);

  if (layoutNodes.length === 0) {
    return { nodes, edges };
  }

  const layoutNodeIds = new Set(layoutNodes.map((node) => node.id));
  const layoutEdges = buildLayoutEdges(nodes, edges, layoutNodeIds);
  const layout = await layoutGraph(layoutNodes, layoutEdges, edgePath, layoutOptions);

  return applyLayoutResult(nodes, edges, layoutNodes, layout);
}
