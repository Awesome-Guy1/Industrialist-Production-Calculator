import { normalizeOrthogonalTurns } from '../utils/canvas/orthogonalEdgeRouting';
import { snapToGrid } from './constants';
import { collectLayoutedEdges, getEdgeAnchors } from './materialize';
import type {
  CollectedLayoutedEdge,
  EdgeUpdate,
  LayoutEdgePathStyle,
  LayoutEdgeSpec,
  LayoutedEdge,
  LayoutGraphResult,
  MaterializedLayoutPass,
} from './types';

function getEdgeOffset(
  edge: LayoutedEdge,
  collectedEdge: CollectedLayoutedEdge,
  pass: MaterializedLayoutPass,
): { x: number; y: number } {
  if (edge.container && edge.container !== 'root') {
    const containerPlacement = pass.placements.get(edge.container);
    if (containerPlacement) {
      return { x: containerPlacement.x, y: containerPlacement.y };
    }
  }

  return { x: collectedEdge.offsetX, y: collectedEdge.offsetY };
}

function getSnappedBendPoints(
  edge: LayoutedEdge,
  offset: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const bendPoints = edge.sections?.[0]?.bendPoints ?? [];
  const snappedPoints: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < bendPoints.length; i++) {
    const point = bendPoints[i];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    snappedPoints.push(snapToGrid((point.x ?? 0) + offset.x, (point.y ?? 0) + offset.y));
  }

  return snappedPoints;
}

export function buildLayoutGraphResult(
  pass: MaterializedLayoutPass,
  layoutEdges: LayoutEdgeSpec[],
  edgePath: LayoutEdgePathStyle,
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

    const offset = getEdgeOffset(collectedEdge.edge, collectedEdge, pass);
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
