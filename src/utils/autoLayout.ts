import type { Edge } from '@xyflow/react';
import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { resolveActiveRecipe } from '../data/lookup';
import type { EdgePathStyle } from '../stores/useEdgeThemeStore';
import type { CanvasNode, GroupNodeType, RecipeNodeType } from '../types/nodes';
import { isGroupNode, isRecipeNode } from '../types/nodes';
import type { EdgeControlPoint } from '../types/edges';
import {
  BASE_INFO_HEIGHT,
  BOTTOM_PADDING,
  IO_COLUMN_PADDING,
  NODE_CSS_WIDTH,
  NODE_HANDLE_SIZE,
  RECT_GAP,
  RECT_HEIGHT,
  SNAP_GRID,
} from '../constants/layoutConstants';
import {
  EMPTY_GROUP_HEIGHT,
  EMPTY_GROUP_WIDTH,
  GROUP_HEADER_HEIGHT,
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  computeGroupBoundsByGroupId,
  getCollapsedGroupHeight,
} from './groupBounds';
import { buildHandleId, parseHandleId } from './idGenerator';
import { normalizeOrthogonalTurns } from './canvas/orthogonalEdgeRouting';
import type { OrthogonalRouteAnchors } from './canvas/orthogonalEdgeRouting';

const IO_COLUMN_TOP_PAD = 17;
const HANDLE_STEP = RECT_HEIGHT + RECT_GAP;
const GRID_X = SNAP_GRID[0];
const GRID_Y = SNAP_GRID[1];

const ROOT_PADDING = `[top=${GRID_Y * 4}, left=${GRID_X * 3}, bottom=${GRID_Y * 4}, right=${GRID_X * 3}]`;
const GROUP_PADDING = `[top=${GROUP_HEADER_HEIGHT + GROUP_PADDING_Y}, left=${GROUP_PADDING_X}, bottom=${GROUP_PADDING_Y}, right=${GROUP_PADDING_X}]`;
const MAX_PORT_ORDER_REFINEMENT_PASSES = 2;

const elk = new ELK({
  workerUrl: elkWorkerUrl,
  workerFactory: (url) => new Worker(url ?? elkWorkerUrl),
});

interface AutoLayoutOptions {
  edgePath?: EdgePathStyle;
}

interface NodeHandlesMeta {
  inputOrder: number[];
  outputOrder: number[];
  inputCount: number;
  outputCount: number;
}

type LayoutNodeKind = 'recipe' | 'collapsed-group' | 'expanded-group';
type PortConstraints = 'FIXED_SIDE' | 'FIXED_POS';
type PortOrderMode = 'current' | 'stable';

interface LayoutNodeSpec {
  id: string;
  kind: LayoutNodeKind;
  parentId?: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  inputOrder: number[];
  outputOrder: number[];
  commitPortOrder: boolean;
}

interface LayoutEdgeSpec {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

interface LayoutGraphResult {
  positions: Map<string, { x: number; y: number }>;
  dimensions: Map<string, { width: number; height: number }>;
  inputOrders: Map<string, number[]>;
  outputOrders: Map<string, number[]>;
  edgeUpdates: Map<string, EdgeUpdate>;
}

interface LayoutedPoint {
  x?: number;
  y?: number;
}

interface LayoutedPort extends LayoutedPoint {
  id: string;
}

interface LayoutedEdgeSection {
  startPoint?: LayoutedPoint;
  endPoint?: LayoutedPoint;
  bendPoints?: LayoutedPoint[];
}

interface LayoutedEdge {
  id: string;
  container?: string;
  sections?: LayoutedEdgeSection[];
}

interface LayoutedNode extends LayoutedPoint {
  id: string;
  width?: number;
  height?: number;
  ports?: LayoutedPort[];
  children?: LayoutedNode[];
  edges?: LayoutedEdge[];
}

interface LayoutedNodePlacement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  ports?: LayoutedPort[];
}

interface LayoutedGraph {
  children?: LayoutedNode[];
  edges?: LayoutedEdge[];
}

interface CollectedLayoutedEdge {
  edge: LayoutedEdge;
  offsetX: number;
  offsetY: number;
}

interface MaterializedLayoutPass {
  layouted: LayoutedGraph;
  layoutNodes: LayoutNodeSpec[];
  nodeMap: Map<string, LayoutNodeSpec>;
  placements: Map<string, LayoutedNodePlacement>;
  positions: Map<string, { x: number; y: number }>;
  dimensions: Map<string, { width: number; height: number }>;
  inputOrders: Map<string, number[]>;
  outputOrders: Map<string, number[]>;
  portOrderScore: number;
}

interface PortOrderRefinement {
  inputOrders: Map<string, number[]>;
  outputOrders: Map<string, number[]>;
  changed: boolean;
}

interface ElkInputNode {
  id: string;
  width?: number;
  height?: number;
  ports?: ReturnType<typeof buildPorts>;
  children?: ElkInputNode[];
  properties?: Record<string, string>;
}

interface EdgeUpdate {
  clearControlPoints?: boolean;
  orthogonalTurns?: EdgeControlPoint[];
}

const createIndexOrder = (count: number): number[] =>
  Array.from({ length: count }, (_unused, index) => index);

const snapX = (x: number): number => Math.round(x / GRID_X) * GRID_X;
const snapY = (y: number): number => Math.round(y / GRID_Y) * GRID_Y;

function snapToGrid(x: number, y: number): { x: number; y: number } {
  return { x: snapX(x), y: snapY(y) };
}

function snapDimension(value: number | undefined, gridSize: number, fallback: number): number {
  const rawValue = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(gridSize, Math.ceil(rawValue / gridSize) * gridSize);
}

function getRecipeNodeHandlesMeta(node: RecipeNodeType): NodeHandlesMeta {
  const recipe = resolveActiveRecipe(node.data.recipeId, node.data.settings, node.id);
  const fallbackInputCount = recipe?.inputs.length ?? 0;
  const fallbackOutputCount = recipe?.outputs.length ?? 0;

  const inputOrder = node.data.inputOrder?.slice() ?? createIndexOrder(fallbackInputCount);
  const outputOrder = node.data.outputOrder?.slice() ?? createIndexOrder(fallbackOutputCount);

  return {
    inputOrder,
    outputOrder,
    inputCount: inputOrder.length,
    outputCount: outputOrder.length,
  };
}

function getCollapsedGroupHandlesMeta(node: GroupNodeType): NodeHandlesMeta {
  const inputCount = node.data.inputProxyHandleIds.length;
  const outputCount = node.data.outputProxyHandleIds.length;

  return {
    inputOrder: createIndexOrder(inputCount),
    outputOrder: createIndexOrder(outputCount),
    inputCount,
    outputCount,
  };
}

function calculateRecipeNodeHeight(node: RecipeNodeType): number {
  const { inputCount, outputCount } = getRecipeNodeHandlesMeta(node);
  const maxCount = Math.max(inputCount, outputCount, 1);
  const ioAreaHeight = maxCount * RECT_HEIGHT + (maxCount - 1) * RECT_GAP + IO_COLUMN_PADDING;
  return BASE_INFO_HEIGHT + ioAreaHeight + BOTTOM_PADDING;
}

function getHandleY(
  side: 'left' | 'right',
  displayIndex: number,
  inputCount: number,
  outputCount: number,
): number {
  const maxCount = Math.max(inputCount, outputCount);
  const sideCount = side === 'left' ? inputCount : outputCount;
  const verticalOffset = ((maxCount - sideCount) * HANDLE_STEP) / 2;
  return (
    BASE_INFO_HEIGHT +
    IO_COLUMN_TOP_PAD +
    verticalOffset +
    displayIndex * HANDLE_STEP +
    RECT_HEIGHT / 2
  );
}

function getLayoutPortY(
  side: 'input' | 'output',
  displayIndex: number,
  inputCount: number,
  outputCount: number,
): number {
  return getHandleY(side === 'input' ? 'left' : 'right', displayIndex, inputCount, outputCount);
}

function createRecipeLayoutNode(node: RecipeNodeType, parentId?: string): LayoutNodeSpec {
  const meta = getRecipeNodeHandlesMeta(node);
  return {
    id: node.id,
    kind: 'recipe',
    parentId,
    position: node.position,
    width: node.width ?? NODE_CSS_WIDTH,
    height: node.height ?? calculateRecipeNodeHeight(node),
    inputOrder: meta.inputOrder,
    outputOrder: meta.outputOrder,
    commitPortOrder: true,
  };
}

function createExpandedGroupLayoutNode(node: GroupNodeType): LayoutNodeSpec {
  return {
    id: node.id,
    kind: 'expanded-group',
    position: node.position,
    width: node.width ?? EMPTY_GROUP_WIDTH,
    height: node.height ?? EMPTY_GROUP_HEIGHT,
    inputOrder: [],
    outputOrder: [],
    commitPortOrder: false,
  };
}

function createCollapsedGroupLayoutNode(node: GroupNodeType): LayoutNodeSpec {
  const meta = getCollapsedGroupHandlesMeta(node);
  const fallbackHeight = getCollapsedGroupHeight(meta.inputCount, meta.outputCount);
  return {
    id: node.id,
    kind: 'collapsed-group',
    position: node.position,
    width: node.width ?? node.measured?.width ?? NODE_CSS_WIDTH,
    height: node.height ?? node.measured?.height ?? fallbackHeight,
    inputOrder: meta.inputOrder,
    outputOrder: meta.outputOrder,
    commitPortOrder: true,
  };
}

function buildPortProperties(side: 'WEST' | 'EAST', displayIndex: number) {
  return {
    'port.side': side,
    'org.eclipse.elk.port.side': side,
    'port.index': String(displayIndex),
    'org.eclipse.elk.port.index': String(displayIndex),
  };
}

function getElkPortOrder(order: number[], mode: PortOrderMode): number[] {
  if (mode === 'current') return order;
  return [...order].sort((a, b) => a - b);
}

function getElkPortIndex(
  handleIndex: number,
  displayIndex: number,
  mode: PortOrderMode,
): number {
  return mode === 'stable' ? handleIndex : displayIndex;
}

function buildFixedPortPosition(
  side: 'input' | 'output',
  nodeWidth: number,
  centerY: number,
): { x: number; y: number } {
  const y = centerY - NODE_HANDLE_SIZE / 2;
  return {
    x: side === 'input' ? -NODE_HANDLE_SIZE : nodeWidth,
    y,
  };
}

function buildPorts(
  node: LayoutNodeSpec,
  inputOrder: number[],
  outputOrder: number[],
  portConstraints: PortConstraints,
  portOrderMode: PortOrderMode,
) {
  const orderedInputs = getElkPortOrder(inputOrder, portOrderMode);
  const orderedOutputs = getElkPortOrder(outputOrder, portOrderMode);
  const inputCount = orderedInputs.length;
  const outputCount = orderedOutputs.length;

  const inputPorts = orderedInputs.map((handleIndex, displayIndex) => {
    const centerY = getLayoutPortY('input', displayIndex, inputCount, outputCount);
    return {
      id: buildHandleId(node.id, 'input', handleIndex),
      width: NODE_HANDLE_SIZE,
      height: NODE_HANDLE_SIZE,
      properties: buildPortProperties(
        'WEST',
        getElkPortIndex(handleIndex, displayIndex, portOrderMode),
      ),
      ...(portConstraints === 'FIXED_POS'
        ? buildFixedPortPosition('input', node.width, centerY)
        : {}),
    };
  });

  const outputPorts = orderedOutputs.map((handleIndex, displayIndex) => {
    const centerY = getLayoutPortY('output', displayIndex, inputCount, outputCount);
    return {
      id: buildHandleId(node.id, 'output', handleIndex),
      width: NODE_HANDLE_SIZE,
      height: NODE_HANDLE_SIZE,
      properties: buildPortProperties(
        'EAST',
        getElkPortIndex(handleIndex, displayIndex, portOrderMode),
      ),
      ...(portConstraints === 'FIXED_POS'
        ? buildFixedPortPosition('output', node.width, centerY)
        : {}),
    };
  });

  return [...inputPorts, ...outputPorts];
}

function buildLayoutNodes(nodes: CanvasNode[]): LayoutNodeSpec[] {
  const groupNodes = nodes.filter(isGroupNode);
  const groupMap = new Map(groupNodes.map((node) => [node.id, node]));
  const layoutNodes: LayoutNodeSpec[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (isGroupNode(node)) {
      layoutNodes.push(
        node.data.collapsed
          ? createCollapsedGroupLayoutNode(node)
          : createExpandedGroupLayoutNode(node),
      );
      continue;
    }

    if (!isRecipeNode(node) || node.hidden) continue;

    const groupNode = node.data.groupId ? groupMap.get(node.data.groupId) : undefined;
    const parentId = groupNode && !groupNode.data.collapsed ? groupNode.id : undefined;
    layoutNodes.push(createRecipeLayoutNode(node, parentId));
  }

  layoutNodes.sort((a, b) => a.id.localeCompare(b.id));
  return layoutNodes;
}

function buildLayoutEdges(
  nodes: CanvasNode[],
  edges: Edge[],
  layoutNodeIds: ReadonlySet<string>,
): LayoutEdgeSpec[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const layoutEdges: LayoutEdgeSpec[] = [];

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (edge.hidden) continue;
    if (!layoutNodeIds.has(edge.source) || !layoutNodeIds.has(edge.target)) continue;

    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    if (!sourceNode || !targetNode) continue;
    if (isGroupNode(sourceNode) && !sourceNode.data.collapsed) continue;
    if (isGroupNode(targetNode) && !targetNode.data.collapsed) continue;

    layoutEdges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? undefined,
      targetHandle: edge.targetHandle ?? undefined,
    });
  }

  layoutEdges.sort((a, b) => a.id.localeCompare(b.id));
  return layoutEdges;
}

function buildHierarchicalElkNodes(
  layoutNodes: LayoutNodeSpec[],
  portConstraints: PortConstraints,
  portOrderMode: PortOrderMode,
): ElkInputNode[] {
  const layoutNodeIds = new Set(layoutNodes.map((node) => node.id));
  const childrenByParentId = new Map<string | null, LayoutNodeSpec[]>();

  for (let i = 0; i < layoutNodes.length; i++) {
    const node = layoutNodes[i];
    const parentId = node.parentId && layoutNodeIds.has(node.parentId) ? node.parentId : null;
    const children = childrenByParentId.get(parentId);
    if (children) {
      children.push(node);
    } else {
      childrenByParentId.set(parentId, [node]);
    }
  }

  childrenByParentId.forEach((children) => {
    children.sort((a, b) => a.id.localeCompare(b.id));
  });

  const buildNode = (node: LayoutNodeSpec): ElkInputNode => {
    if (node.kind === 'expanded-group') {
      const children = (childrenByParentId.get(node.id) ?? []).map(buildNode);
      const elkNode: ElkInputNode = {
        id: node.id,
        children,
        properties: {
          'elk.padding': GROUP_PADDING,
        },
      };

      if (children.length === 0) {
        elkNode.width = node.width;
        elkNode.height = node.height;
      }

      return elkNode;
    }

    return {
      id: node.id,
      width: node.width,
      height: node.height,
      ports: buildPorts(
        node,
        node.inputOrder,
        node.outputOrder,
        portConstraints,
        portOrderMode,
      ),
      properties: {
        portConstraints,
        'org.eclipse.elk.portConstraints': portConstraints,
      },
    };
  };

  return (childrenByParentId.get(null) ?? []).map(buildNode);
}

function buildElkEdges(layoutEdges: LayoutEdgeSpec[]) {
  return layoutEdges.map((edge) => ({
    id: edge.id,
    sources: [edge.sourceHandle ?? buildHandleId(edge.source, 'output', 0)],
    targets: [edge.targetHandle ?? buildHandleId(edge.target, 'input', 0)],
  }));
}

function getElkLayoutProperties(edgePath: EdgePathStyle): Record<string, string> {
  const edgeRouting = edgePath === 'straight' ? 'POLYLINE' : 'ORTHOGONAL';

  return {
    algorithm: 'layered',
    'elk.direction': 'RIGHT',
    'elk.edgeRouting': edgeRouting,
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.randomSeed': '1',
    'elk.separateConnectedComponents': 'true',
    'elk.spacing.baseValue': String(GRID_X),
    'elk.spacing.componentComponent': String(GRID_X * 8),
    'elk.spacing.nodeNode': String(GRID_Y * 3),
    'elk.spacing.edgeNode': String(GRID_Y * 3),
    'elk.spacing.edgeEdge': String(GRID_Y * 2),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(GRID_X * 8),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(GRID_X * 2),
    'elk.layered.spacing.edgeEdgeBetweenLayers': String(GRID_Y * 2),
    'elk.layered.feedbackEdges': 'true',
    'elk.layered.cycleBreaking.strategy': 'GREEDY',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.favorStraightEdges': 'true',
    'elk.layered.nodePlacement.bk.edgeStraightening': 'IMPROVE_STRAIGHTNESS',
    'elk.padding': ROOT_PADDING,
  };
}

function collectLayoutedNodePlacements(
  children: LayoutedNode[] | undefined,
  placements: Map<string, LayoutedNodePlacement>,
  offsetX = 0,
  offsetY = 0,
): void {
  if (!children) return;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const x = offsetX + (child.x ?? 0);
    const y = offsetY + (child.y ?? 0);

    placements.set(child.id, {
      id: child.id,
      x,
      y,
      width: child.width ?? 0,
      height: child.height ?? 0,
      ports: child.ports,
    });

    collectLayoutedNodePlacements(child.children, placements, x, y);
  }
}

function collectLayoutedEdges(
  graph: LayoutedGraph | LayoutedNode,
  edges: CollectedLayoutedEdge[],
  offsetX = 0,
  offsetY = 0,
): void {
  const graphEdges = graph.edges ?? [];
  for (let i = 0; i < graphEdges.length; i++) {
    edges.push({ edge: graphEdges[i], offsetX, offsetY });
  }

  const children = graph.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    collectLayoutedEdges(
      child,
      edges,
      offsetX + (child.x ?? 0),
      offsetY + (child.y ?? 0),
    );
  }
}

function getCompletePortOrder(candidate: number[], fallback: number[]): number[] {
  if (candidate.length !== fallback.length) return fallback;

  const fallbackSet = new Set(fallback);
  const seen = new Set<number>();
  for (let i = 0; i < candidate.length; i++) {
    const index = candidate[i];
    if (!fallbackSet.has(index) || seen.has(index)) return fallback;
    seen.add(index);
  }

  return candidate;
}

function arePortOrdersEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function collectPortOrders(
  placements: Map<string, LayoutedNodePlacement>,
  nodeMap: Map<string, LayoutNodeSpec>,
  inputOrders: Map<string, number[]>,
  outputOrders: Map<string, number[]>,
): void {
  placements.forEach((placement) => {
    const node = nodeMap.get(placement.id);
    if (!node?.commitPortOrder) return;

    const ports = placement.ports ?? [];
    const inputs: Array<{ index: number; y: number }> = [];
    const outputs: Array<{ index: number; y: number }> = [];

    for (let i = 0; i < ports.length; i++) {
      const port = ports[i];
      const parsed = parseHandleId(port.id);
      if (!parsed) continue;

      if (parsed.side === 'input') {
        inputs.push({ index: parsed.index, y: port.y ?? 0 });
      } else {
        outputs.push({ index: parsed.index, y: port.y ?? 0 });
      }
    }

    inputs.sort((a, b) => a.y - b.y || a.index - b.index);
    outputs.sort((a, b) => a.y - b.y || a.index - b.index);

    inputOrders.set(
      placement.id,
      getCompletePortOrder(
        inputs.map((input) => input.index),
        node.inputOrder,
      ),
    );
    outputOrders.set(
      placement.id,
      getCompletePortOrder(
        outputs.map((output) => output.index),
        node.outputOrder,
      ),
    );
  });
}

function getHandleDisplayIndex(order: number[], handleIndex: number): number {
  const displayIndex = order.indexOf(handleIndex);
  if (displayIndex >= 0) return displayIndex;
  if (order.length === 0) return 0;
  return Math.max(0, Math.min(handleIndex, order.length - 1));
}

function getPortAnchor(
  node: LayoutNodeSpec,
  handleId: string | undefined,
  fallbackSide: 'input' | 'output',
  position: { x: number; y: number },
  dimension: { width: number; height: number },
  inputOrders: Map<string, number[]>,
  outputOrders: Map<string, number[]>,
): EdgeControlPoint | null {
  const parsed = parseHandleId(handleId ?? buildHandleId(node.id, fallbackSide, 0));
  if (!parsed) return null;

  const inputOrder = inputOrders.get(node.id) ?? node.inputOrder;
  const outputOrder = outputOrders.get(node.id) ?? node.outputOrder;
  const order = parsed.side === 'input' ? inputOrder : outputOrder;
  const displayIndex = getHandleDisplayIndex(order, parsed.index);
  const y =
    position.y + getLayoutPortY(parsed.side, displayIndex, inputOrder.length, outputOrder.length);

  return {
    x: parsed.side === 'output' ? position.x + dimension.width : position.x,
    y,
  };
}

function getEdgeAnchors(
  edge: LayoutEdgeSpec,
  nodeMap: Map<string, LayoutNodeSpec>,
  positions: Map<string, { x: number; y: number }>,
  dimensions: Map<string, { width: number; height: number }>,
  inputOrders: Map<string, number[]>,
  outputOrders: Map<string, number[]>,
): OrthogonalRouteAnchors | null {
  const sourceNode = nodeMap.get(edge.source);
  const targetNode = nodeMap.get(edge.target);
  const sourcePosition = positions.get(edge.source);
  const targetPosition = positions.get(edge.target);
  const sourceDimension = dimensions.get(edge.source);
  const targetDimension = dimensions.get(edge.target);

  if (
    !sourceNode ||
    !targetNode ||
    !sourcePosition ||
    !targetPosition ||
    !sourceDimension ||
    !targetDimension
  ) {
    return null;
  }

  const sourceAnchor = getPortAnchor(
    sourceNode,
    edge.sourceHandle,
    'output',
    sourcePosition,
    sourceDimension,
    inputOrders,
    outputOrders,
  );
  const targetAnchor = getPortAnchor(
    targetNode,
    edge.targetHandle,
    'input',
    targetPosition,
    targetDimension,
    inputOrders,
    outputOrders,
  );

  if (!sourceAnchor || !targetAnchor) return null;

  return {
    sourceX: sourceAnchor.x,
    sourceY: sourceAnchor.y,
    targetX: targetAnchor.x,
    targetY: targetAnchor.y,
  };
}

function addPortNeighborY(
  neighborYsByHandleId: Map<string, number[]>,
  handleId: string,
  y: number,
): void {
  const values = neighborYsByHandleId.get(handleId);
  if (values) {
    values.push(y);
  } else {
    neighborYsByHandleId.set(handleId, [y]);
  }
}

function getLayoutEdgeHandleIds(edge: LayoutEdgeSpec): {
  sourceHandle: string;
  targetHandle: string;
} {
  return {
    sourceHandle: edge.sourceHandle ?? buildHandleId(edge.source, 'output', 0),
    targetHandle: edge.targetHandle ?? buildHandleId(edge.target, 'input', 0),
  };
}

function collectPortNeighborYs(
  layoutEdges: LayoutEdgeSpec[],
  nodeMap: Map<string, LayoutNodeSpec>,
  positions: Map<string, { x: number; y: number }>,
  dimensions: Map<string, { width: number; height: number }>,
  inputOrders: Map<string, number[]>,
  outputOrders: Map<string, number[]>,
): Map<string, number[]> {
  const neighborYsByHandleId = new Map<string, number[]>();

  for (let i = 0; i < layoutEdges.length; i++) {
    const edge = layoutEdges[i];
    if (edge.source === edge.target) continue;

    const { sourceHandle, targetHandle } = getLayoutEdgeHandleIds(edge);
    const sourceParsed = parseHandleId(sourceHandle);
    const targetParsed = parseHandleId(targetHandle);
    if (
      !sourceParsed ||
      !targetParsed ||
      sourceParsed.side !== 'output' ||
      targetParsed.side !== 'input'
    ) {
      continue;
    }

    const anchors = getEdgeAnchors(
      edge,
      nodeMap,
      positions,
      dimensions,
      inputOrders,
      outputOrders,
    );
    if (!anchors || anchors.targetX <= anchors.sourceX) continue;

    addPortNeighborY(neighborYsByHandleId, sourceHandle, anchors.targetY);
    addPortNeighborY(neighborYsByHandleId, targetHandle, anchors.sourceY);
  }

  return neighborYsByHandleId;
}

function getMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function countPortOrderInversions(
  nodeId: string,
  side: 'input' | 'output',
  order: number[],
  neighborYsByHandleId: Map<string, number[]>,
): number {
  const orderedNeighborYs: number[] = [];

  for (let i = 0; i < order.length; i++) {
    const handleIndex = order[i];
    const values = neighborYsByHandleId.get(buildHandleId(nodeId, side, handleIndex));
    if (!values || values.length === 0) continue;
    orderedNeighborYs.push(getMedian(values));
  }

  let inversions = 0;
  for (let i = 0; i < orderedNeighborYs.length; i++) {
    for (let j = i + 1; j < orderedNeighborYs.length; j++) {
      if (orderedNeighborYs[i] > orderedNeighborYs[j]) {
        inversions++;
      }
    }
  }

  return inversions;
}

function scorePortOrders(
  layoutNodes: LayoutNodeSpec[],
  layoutEdges: LayoutEdgeSpec[],
  nodeMap: Map<string, LayoutNodeSpec>,
  positions: Map<string, { x: number; y: number }>,
  dimensions: Map<string, { width: number; height: number }>,
  inputOrders: Map<string, number[]>,
  outputOrders: Map<string, number[]>,
): number {
  const neighborYsByHandleId = collectPortNeighborYs(
    layoutEdges,
    nodeMap,
    positions,
    dimensions,
    inputOrders,
    outputOrders,
  );

  let score = 0;
  for (let i = 0; i < layoutNodes.length; i++) {
    const node = layoutNodes[i];
    if (!node.commitPortOrder) continue;

    score += countPortOrderInversions(
      node.id,
      'input',
      inputOrders.get(node.id) ?? node.inputOrder,
      neighborYsByHandleId,
    );
    score += countPortOrderInversions(
      node.id,
      'output',
      outputOrders.get(node.id) ?? node.outputOrder,
      neighborYsByHandleId,
    );
  }

  return score;
}

function refineSidePortOrder(
  nodeId: string,
  side: 'input' | 'output',
  currentOrder: number[],
  neighborYsByHandleId: Map<string, number[]>,
): number[] {
  const connectedHandles: Array<{
    handleIndex: number;
    displayIndex: number;
    neighborY: number;
  }> = [];

  for (let displayIndex = 0; displayIndex < currentOrder.length; displayIndex++) {
    const handleIndex = currentOrder[displayIndex];
    const values = neighborYsByHandleId.get(buildHandleId(nodeId, side, handleIndex));
    if (!values || values.length === 0) continue;
    connectedHandles.push({
      handleIndex,
      displayIndex,
      neighborY: getMedian(values),
    });
  }

  if (connectedHandles.length < 2) return currentOrder;

  const connectedSlots = connectedHandles
    .map((handle) => handle.displayIndex)
    .sort((a, b) => a - b);
  const sortedHandles = connectedHandles
    .slice()
    .sort(
      (a, b) =>
        a.neighborY - b.neighborY ||
        a.displayIndex - b.displayIndex ||
        a.handleIndex - b.handleIndex,
    );
  const candidate = currentOrder.slice();

  for (let i = 0; i < connectedSlots.length; i++) {
    candidate[connectedSlots[i]] = sortedHandles[i].handleIndex;
  }

  const currentScore = countPortOrderInversions(
    nodeId,
    side,
    currentOrder,
    neighborYsByHandleId,
  );
  const candidateScore = countPortOrderInversions(
    nodeId,
    side,
    candidate,
    neighborYsByHandleId,
  );

  if (candidateScore >= currentScore || arePortOrdersEqual(candidate, currentOrder)) {
    return currentOrder;
  }

  return candidate;
}

function getEdgeOffset(
  edge: LayoutedEdge,
  collectedEdge: CollectedLayoutedEdge,
  placements: Map<string, LayoutedNodePlacement>,
): { x: number; y: number } {
  if (edge.container && edge.container !== 'root') {
    const containerPlacement = placements.get(edge.container);
    if (containerPlacement) {
      return { x: containerPlacement.x, y: containerPlacement.y };
    }
  }

  return { x: collectedEdge.offsetX, y: collectedEdge.offsetY };
}

function getSnappedBendPoints(
  edge: LayoutedEdge,
  offset: { x: number; y: number },
): EdgeControlPoint[] {
  const bendPoints = edge.sections?.[0]?.bendPoints ?? [];
  const snappedPoints: EdgeControlPoint[] = [];

  for (let i = 0; i < bendPoints.length; i++) {
    const point = bendPoints[i];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    snappedPoints.push(snapToGrid((point.x ?? 0) + offset.x, (point.y ?? 0) + offset.y));
  }

  return snappedPoints;
}

async function runElkLayoutPass(
  layoutNodes: LayoutNodeSpec[],
  layoutEdges: LayoutEdgeSpec[],
  edgePath: EdgePathStyle,
  portConstraints: PortConstraints,
  portOrderMode: PortOrderMode,
): Promise<LayoutedGraph> {
  return (await elk.layout({
    id: 'root',
    properties: getElkLayoutProperties(edgePath),
    children: buildHierarchicalElkNodes(layoutNodes, portConstraints, portOrderMode),
    edges: buildElkEdges(layoutEdges),
  })) as LayoutedGraph;
}

function materializeLayoutPass(
  layoutNodes: LayoutNodeSpec[],
  layoutEdges: LayoutEdgeSpec[],
  layouted: LayoutedGraph,
): MaterializedLayoutPass {
  const nodeMap = new Map(layoutNodes.map((node) => [node.id, node]));
  const placements = new Map<string, LayoutedNodePlacement>();
  collectLayoutedNodePlacements(layouted.children, placements);

  const positions = new Map<string, { x: number; y: number }>();
  const dimensions = new Map<string, { width: number; height: number }>();

  placements.forEach((placement) => {
    const spec = nodeMap.get(placement.id);
    positions.set(placement.id, snapToGrid(placement.x, placement.y));
    dimensions.set(placement.id, {
      width: snapDimension(placement.width, GRID_X, spec?.width ?? GRID_X),
      height: snapDimension(placement.height, GRID_Y, spec?.height ?? GRID_Y),
    });
  });

  const inputOrders = new Map<string, number[]>();
  const outputOrders = new Map<string, number[]>();
  collectPortOrders(placements, nodeMap, inputOrders, outputOrders);

  return {
    layouted,
    layoutNodes,
    nodeMap,
    placements,
    positions,
    dimensions,
    inputOrders,
    outputOrders,
    portOrderScore: scorePortOrders(
      layoutNodes,
      layoutEdges,
      nodeMap,
      positions,
      dimensions,
      inputOrders,
      outputOrders,
    ),
  };
}

function collectLayoutedPortOrders(
  layoutNodes: LayoutNodeSpec[],
  layouted: LayoutedGraph,
): {
  inputOrders: Map<string, number[]>;
  outputOrders: Map<string, number[]>;
} {
  const nodeMap = new Map(layoutNodes.map((node) => [node.id, node]));
  const placements = new Map<string, LayoutedNodePlacement>();
  collectLayoutedNodePlacements(layouted.children, placements);

  const inputOrders = new Map<string, number[]>();
  const outputOrders = new Map<string, number[]>();
  collectPortOrders(placements, nodeMap, inputOrders, outputOrders);

  return { inputOrders, outputOrders };
}

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

function collectRefinedPortOrders(
  pass: MaterializedLayoutPass,
  layoutEdges: LayoutEdgeSpec[],
): PortOrderRefinement {
  const neighborYsByHandleId = collectPortNeighborYs(
    layoutEdges,
    pass.nodeMap,
    pass.positions,
    pass.dimensions,
    pass.inputOrders,
    pass.outputOrders,
  );
  const inputOrders = new Map<string, number[]>();
  const outputOrders = new Map<string, number[]>();
  let changed = false;

  for (let i = 0; i < pass.layoutNodes.length; i++) {
    const node = pass.layoutNodes[i];
    if (!node.commitPortOrder) continue;

    const currentInputOrder = pass.inputOrders.get(node.id) ?? node.inputOrder;
    const currentOutputOrder = pass.outputOrders.get(node.id) ?? node.outputOrder;
    const inputOrder = refineSidePortOrder(
      node.id,
      'input',
      currentInputOrder,
      neighborYsByHandleId,
    );
    const outputOrder = refineSidePortOrder(
      node.id,
      'output',
      currentOutputOrder,
      neighborYsByHandleId,
    );

    inputOrders.set(node.id, inputOrder);
    outputOrders.set(node.id, outputOrder);
    changed =
      changed ||
      !arePortOrdersEqual(inputOrder, currentInputOrder) ||
      !arePortOrdersEqual(outputOrder, currentOutputOrder);
  }

  return { inputOrders, outputOrders, changed };
}

function buildLayoutGraphResult(
  pass: MaterializedLayoutPass,
  layoutEdges: LayoutEdgeSpec[],
  edgePath: EdgePathStyle,
): LayoutGraphResult {
  const edgeUpdates = new Map<string, EdgeUpdate>();
  if (edgePath === 'bezier' || edgePath === 'straight') {
    for (let i = 0; i < layoutEdges.length; i++) {
      edgeUpdates.set(layoutEdges[i].id, { clearControlPoints: true });
    }
    return {
      positions: pass.positions,
      dimensions: pass.dimensions,
      inputOrders: pass.inputOrders,
      outputOrders: pass.outputOrders,
      edgeUpdates,
    };
  }

  const edgeMap = new Map(layoutEdges.map((edge) => [edge.id, edge]));
  const layoutedEdges: CollectedLayoutedEdge[] = [];
  collectLayoutedEdges(pass.layouted, layoutedEdges);

  for (let i = 0; i < layoutedEdges.length; i++) {
    const collectedEdge = layoutedEdges[i];
    const layoutEdge = edgeMap.get(collectedEdge.edge.id);
    if (!layoutEdge) continue;

    const anchors = getEdgeAnchors(
      layoutEdge,
      pass.nodeMap,
      pass.positions,
      pass.dimensions,
      pass.inputOrders,
      pass.outputOrders,
    );
    if (!anchors) continue;

    const offset = getEdgeOffset(collectedEdge.edge, collectedEdge, pass.placements);
    const bendPoints = getSnappedBendPoints(collectedEdge.edge, offset);
    edgeUpdates.set(layoutEdge.id, {
      orthogonalTurns: normalizeOrthogonalTurns(bendPoints, anchors),
    });
  }

  for (let i = 0; i < layoutEdges.length; i++) {
    const layoutEdge = layoutEdges[i];
    if (edgeUpdates.has(layoutEdge.id)) continue;

    const anchors = getEdgeAnchors(
      layoutEdge,
      pass.nodeMap,
      pass.positions,
      pass.dimensions,
      pass.inputOrders,
      pass.outputOrders,
    );
    edgeUpdates.set(layoutEdge.id, {
      orthogonalTurns: anchors ? normalizeOrthogonalTurns([], anchors) : [],
    });
  }

  return {
    positions: pass.positions,
    dimensions: pass.dimensions,
    inputOrders: pass.inputOrders,
    outputOrders: pass.outputOrders,
    edgeUpdates,
  };
}

async function layoutGraph(
  layoutNodes: LayoutNodeSpec[],
  layoutEdges: LayoutEdgeSpec[],
  edgePath: EdgePathStyle,
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
    'FIXED_POS',
    'current',
  );
  let activePass = materializeLayoutPass(orderedLayoutNodes, layoutEdges, layouted);

  for (let i = 0; i < MAX_PORT_ORDER_REFINEMENT_PASSES; i++) {
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
      'FIXED_POS',
      'current',
    );
    const refinedPass = materializeLayoutPass(refinedLayoutNodes, layoutEdges, refinedLayouted);

    if (refinedPass.portOrderScore >= activePass.portOrderScore) break;
    activePass = refinedPass;
  }

  return buildLayoutGraphResult(activePass, layoutEdges, edgePath);
}

function applyIndexOrder<T>(values: T[], order: number[] | undefined): T[] {
  if (!order || order.length !== values.length) return values;

  const seen = new Set<number>();
  const ordered: T[] = [];
  for (let i = 0; i < order.length; i++) {
    const index = order[i];
    if (index < 0 || index >= values.length || seen.has(index)) return values;
    seen.add(index);
    ordered.push(values[index]);
  }

  return ordered;
}

function applyEdgeUpdate(edge: Edge, update: EdgeUpdate): Edge {
  const nextData: Record<string, unknown> = {
    ...(edge.data as Record<string, unknown> | undefined),
  };

  if (update.clearControlPoints) {
    delete nextData.controlPoints;
  }

  if (update.orthogonalTurns && update.orthogonalTurns.length > 0) {
    nextData.orthogonalTurns = update.orthogonalTurns;
  } else if ('orthogonalTurns' in nextData) {
    delete nextData.orthogonalTurns;
  }

  return {
    ...edge,
    data: nextData,
  };
}

function applyExpandedGroupBounds(
  nodes: readonly CanvasNode[],
  expandedGroupIds: ReadonlySet<string>,
): CanvasNode[] {
  if (expandedGroupIds.size === 0) return nodes as CanvasNode[];

  const boundsByGroupId = computeGroupBoundsByGroupId(nodes, expandedGroupIds);
  let changed = false;
  const nextNodes = new Array<CanvasNode>(nodes.length);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!isGroupNode(node) || node.data.collapsed || !expandedGroupIds.has(node.id)) {
      nextNodes[i] = node;
      continue;
    }

    const bounds = boundsByGroupId.get(node.id);
    if (!bounds) {
      nextNodes[i] = node;
      continue;
    }

    if (
      node.position.x === bounds.x &&
      node.position.y === bounds.y &&
      node.width === bounds.width &&
      node.height === bounds.height
    ) {
      nextNodes[i] = node;
      continue;
    }

    changed = true;
    nextNodes[i] = {
      ...node,
      position: { x: bounds.x, y: bounds.y },
      width: bounds.width,
      height: bounds.height,
    };
  }

  return changed ? nextNodes : (nodes as CanvasNode[]);
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
  const groupNodes = nodes.filter(isGroupNode);
  const groupMap = new Map(groupNodes.map((node) => [node.id, node]));
  const layoutNodes = buildLayoutNodes(nodes);

  if (layoutNodes.length === 0) {
    return { nodes, edges };
  }

  const layoutNodeIds = new Set(layoutNodes.map((node) => node.id));
  const layoutEdges = buildLayoutEdges(nodes, edges, layoutNodeIds);
  const layout = await layoutGraph(layoutNodes, layoutEdges, edgePath);

  const finalPositions = new Map<string, { x: number; y: number }>();
  const finalInputOrders = new Map<string, number[]>();
  const finalOutputOrders = new Map<string, number[]>();
  const finalGroupDimensions = new Map<string, { width: number; height: number }>();
  const collapsedGroupDeltas = new Map<string, { dx: number; dy: number }>();

  for (let i = 0; i < layoutNodes.length; i++) {
    const layoutNode = layoutNodes[i];
    const position = layout.positions.get(layoutNode.id);
    if (!position) continue;

    finalPositions.set(layoutNode.id, position);

    if (layoutNode.kind === 'recipe') {
      finalInputOrders.set(
        layoutNode.id,
        layout.inputOrders.get(layoutNode.id) ?? layoutNode.inputOrder,
      );
      finalOutputOrders.set(
        layoutNode.id,
        layout.outputOrders.get(layoutNode.id) ?? layoutNode.outputOrder,
      );
      continue;
    }

    finalGroupDimensions.set(
      layoutNode.id,
      layout.dimensions.get(layoutNode.id) ?? {
        width: layoutNode.width,
        height: layoutNode.height,
      },
    );

    const groupNode = groupMap.get(layoutNode.id);
    if (groupNode?.data.collapsed) {
      collapsedGroupDeltas.set(layoutNode.id, {
        dx: position.x - groupNode.position.x,
        dy: position.y - groupNode.position.y,
      });
    }
  }

  const updatedNodes = nodes.map((node) => {
    if (isRecipeNode(node)) {
      let position = finalPositions.get(node.id);
      if (!position && node.hidden && node.data.groupId) {
        const delta = collapsedGroupDeltas.get(node.data.groupId);
        if (delta) {
          position = snapToGrid(node.position.x + delta.dx, node.position.y + delta.dy);
        }
      }

      const inputOrder = finalInputOrders.get(node.id) ?? node.data.inputOrder;
      const outputOrder = finalOutputOrders.get(node.id) ?? node.data.outputOrder;

      if (
        !position &&
        inputOrder === node.data.inputOrder &&
        outputOrder === node.data.outputOrder
      ) {
        return node;
      }

      return {
        ...node,
        position: position ?? node.position,
        data: {
          ...node.data,
          inputOrder,
          outputOrder,
        },
      };
    }

    if (!isGroupNode(node)) return node;

    const position = finalPositions.get(node.id);
    const dimensions = finalGroupDimensions.get(node.id);

    if (!node.data.collapsed) {
      if (!position && !dimensions) return node;
      return {
        ...node,
        position: position ?? node.position,
        width: dimensions?.width ?? node.width,
        height: dimensions?.height ?? node.height,
      };
    }

    const inputProxyHandleIds = applyIndexOrder(
      node.data.inputProxyHandleIds,
      layout.inputOrders.get(node.id),
    );
    const outputProxyHandleIds = applyIndexOrder(
      node.data.outputProxyHandleIds,
      layout.outputOrders.get(node.id),
    );

    return {
      ...node,
      position: position ?? node.position,
      width: dimensions?.width ?? node.width,
      height: dimensions?.height ?? node.height,
      data: {
        ...node.data,
        inputProxyHandleIds,
        outputProxyHandleIds,
      },
    };
  });

  const expandedGroupIds = new Set(
    groupNodes.filter((node) => !node.data.collapsed).map((node) => node.id),
  );
  const boundedNodes = applyExpandedGroupBounds(updatedNodes, expandedGroupIds);

  const updatedEdges = edges.map((edge) => {
    const update = layout.edgeUpdates.get(edge.id);
    return update ? applyEdgeUpdate(edge, update) : edge;
  });

  return { nodes: boundedNodes, edges: updatedEdges };
}
