import { useMemo, useCallback, useState } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Panel,
  Handle,
  Position,
  BackgroundVariant
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import type { GraphData, GraphNode, GraphNodeType } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

const nodeColorMap: Record<GraphNodeType, string> = {
  machine: "var(--color-blue-500)",
  component: "var(--color-amber-500)",
  subsystem: "var(--color-green-500)",
  process: "var(--color-purple-500)",
  part: "var(--color-slate-400)",
  material: "var(--color-orange-500)",
  sensor: "var(--color-cyan-500)",
  system: "var(--color-indigo-500)",
  assembly: "var(--color-rose-500)",
  document_section: "var(--color-slate-600)",
};

const nodeTailwindColor: Record<GraphNodeType, string> = {
  machine: "bg-blue-500/10 border-blue-500/50 text-blue-400",
  component: "bg-amber-500/10 border-amber-500/50 text-amber-400",
  subsystem: "bg-green-500/10 border-green-500/50 text-green-400",
  process: "bg-purple-500/10 border-purple-500/50 text-purple-400",
  part: "bg-slate-400/10 border-slate-400/50 text-slate-400",
  material: "bg-orange-500/10 border-orange-500/50 text-orange-400",
  sensor: "bg-cyan-500/10 border-cyan-500/50 text-cyan-400",
  system: "bg-indigo-500/10 border-indigo-500/50 text-indigo-400",
  assembly: "bg-rose-500/10 border-rose-500/50 text-rose-400",
  document_section: "bg-slate-600/10 border-slate-600/50 text-slate-400",
};

function CustomNode({ data }: { data: { node: GraphNode } }) {
  const colorClass = nodeTailwindColor[data.node.type] || "bg-card border-border";
  return (
    <div className={`px-4 py-2 shadow-sm rounded-md border font-mono text-xs ${colorClass} max-w-[200px] truncate`}>
      <Handle type="target" position={Position.Top} className="w-2 h-2 opacity-50" />
      <div className="font-bold truncate">{data.node.name}</div>
      <div className="text-[10px] opacity-70 uppercase tracking-widest mt-1">{data.node.type}</div>
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 opacity-50" />
    </div>
  );
}

const nodeTypes = {
  custom: CustomNode,
};

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const nodeWidth = 200;
const nodeHeight = 60;

const getLayoutedElements = (nodes: any[], edges: any[], direction = 'TB') => {
  const isHorizontal = direction === 'LR';
  dagreGraph.setGraph({ rankdir: direction });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const newNode = {
      ...node,
      targetPosition: isHorizontal ? 'left' : 'top',
      sourcePosition: isHorizontal ? 'right' : 'bottom',
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
    };
    return newNode;
  });

  return { nodes: newNodes, edges };
};

interface GraphViewProps {
  data: GraphData;
}

export function GraphView({ data }: GraphViewProps) {
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    const rfNodes = data.nodes.map((node) => ({
      id: node.id.toString(),
      type: 'custom',
      data: { node },
      position: { x: 0, y: 0 },
    }));

    const rfEdges = data.edges.map((edge) => ({
      id: edge.id.toString(),
      source: edge.sourceEntityId.toString(),
      target: edge.targetEntityId.toString(),
      label: edge.label,
      animated: true,
      style: { stroke: 'hsl(var(--muted-foreground))', opacity: 0.5 },
      labelStyle: { fill: 'hsl(var(--foreground))', fontWeight: 700, fontSize: 10, fontFamily: 'monospace' },
      labelBgStyle: { fill: 'hsl(var(--background))', fillOpacity: 0.8 },
    }));

    return getLayoutedElements(rfNodes, rfEdges);
  }, [data]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onNodeClick = useCallback((_: any, node: any) => {
    setSelectedNode(node.data.node);
  }, []);

  return (
    <div className="w-full h-full relative rounded-lg border border-border overflow-hidden bg-background">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        className="bg-background"
        minZoom={0.1}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={2} color="hsl(var(--muted))" />
        <Controls className="bg-card border border-border fill-foreground" />
        <MiniMap 
          nodeColor={(node) => {
            const type = (node.data as any)?.node?.type as GraphNodeType;
            return type ? `var(--color-${nodeColorMap[type]?.split('-')[2]}-500, #888)` : '#888';
          }}
          className="bg-card border border-border"
          maskColor="hsl(var(--background) / 0.5)"
        />
      </ReactFlow>

      {selectedNode && (
        <Card className="absolute top-4 right-4 w-80 shadow-lg border-border bg-card/95 backdrop-blur z-10 font-mono">
          <CardHeader className="pb-3 border-b border-border/50">
            <div className="flex justify-between items-start">
              <CardTitle className="text-sm uppercase">{selectedNode.name}</CardTitle>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setSelectedNode(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <Badge variant="secondary" className={`mt-2 ${nodeTailwindColor[selectedNode.type]}`}>
              {selectedNode.type}
            </Badge>
          </CardHeader>
          <CardContent className="pt-4 text-xs space-y-4 text-muted-foreground">
            {selectedNode.sectionPath && (
              <div className="flex items-start gap-1.5">
                <span className="mt-0.5 shrink-0 opacity-50">§</span>
                <p className="text-[10px] leading-relaxed opacity-80 break-words">
                  {selectedNode.sectionPath}
                </p>
              </div>
            )}
            <div>
              <strong className="text-foreground mb-1 block">Description</strong>
              <p className="line-clamp-4">{selectedNode.description}</p>
            </div>
            {selectedNode.properties && Object.keys(selectedNode.properties).length > 0 && (
              <div>
                <strong className="text-foreground mb-1 block">Properties</strong>
                <pre className="bg-background p-2 rounded border border-border overflow-auto max-h-32 text-[10px]">
                  {JSON.stringify(selectedNode.properties, null, 2)}
                </pre>
              </div>
            )}
            {(selectedNode.extractionStartPage != null || (selectedNode.pageReferences && selectedNode.pageReferences.length > 0)) && (
              <div>
                <strong className="text-foreground mb-1 block">Pages</strong>
                {selectedNode.extractionStartPage != null ? (
                  <p>
                    {selectedNode.extractionStartPage === selectedNode.extractionEndPage || selectedNode.extractionEndPage == null
                      ? `p. ${selectedNode.extractionStartPage}`
                      : `pp. ${selectedNode.extractionStartPage}–${selectedNode.extractionEndPage}`}
                  </p>
                ) : (
                  <p>{selectedNode.pageReferences!.join(", ")}</p>
                )}
              </div>
            )}
            {selectedNode.manualName && (
              <div>
                <strong className="text-foreground mb-1 block">Source Manual</strong>
                <p>{selectedNode.manualName}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
