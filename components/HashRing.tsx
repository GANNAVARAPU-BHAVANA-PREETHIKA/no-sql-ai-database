import React, { useEffect, useState } from 'react';
import { Node, DataItem, NodeStatus, TrafficEvent } from '../types';

interface HashRingProps {
  nodes: Node[];
  data: Record<string, DataItem>;
  traffic: TrafficEvent[];
  selectedKey?: string | null;
  onSelectKey?: (key: string) => void;
}

const HashRing: React.FC<HashRingProps> = ({ nodes, data, traffic, selectedKey, onSelectKey }) => {
  const radius = 140;
  const center = 200;

  const getCoordinates = (angle: number, offset: number = 0) => {
    const rad = (angle - 90) * (Math.PI / 180);
    return {
      x: center + (radius + offset) * Math.cos(rad),
      y: center + (radius + offset) * Math.sin(rad),
    };
  };

  const selectedItem = selectedKey ? data[selectedKey] : null;

  return (
    <div className="flex justify-center items-center p-4">
      <svg width="400" height="400" className="bg-slate-900 rounded-full shadow-2xl shadow-black/50 border border-slate-700 overflow-visible">
        {/* Ring Background */}
        <circle cx={center} cy={center} r={radius} stroke="#334155" strokeWidth="2" fill="none" />
        <circle cx={center} cy={center} r={radius - 40} stroke="#1e293b" strokeWidth="1" fill="#0f172a" />

        {/* Center Hub (Load Balancer Representation) */}
        <circle cx={center} cy={center} r="20" fill="#312e81" stroke="#6366f1" strokeWidth="2" className="opacity-80" />
        <text x={center} y={center} dy=".3em" textAnchor="middle" className="text-[8px] fill-indigo-200 font-mono font-bold">LB</text>

        {/* Selected Data Replica Connections */}
        {selectedItem && selectedItem.replicas.map(replicaId => {
          const node = nodes.find(n => n.id === replicaId);
          if (!node) return null;
          const dataCoords = getCoordinates(selectedItem.hash, -20);
          const nodeCoords = getCoordinates(node.angle, 20);
          
          return (
            <g key={`link-${selectedItem.key}-${node.id}`}>
               <line
                x1={dataCoords.x}
                y1={dataCoords.y}
                x2={nodeCoords.x}
                y2={nodeCoords.y}
                stroke="#facc15"
                strokeWidth="1"
                strokeDasharray="4"
                opacity="0.4"
              />
            </g>
          );
        })}

        {/* Data Points */}
        {(Object.values(data) as DataItem[]).map((item) => {
          const coords = getCoordinates(item.hash, -20);
          const isSelected = selectedKey === item.key;
          return (
            <g 
                key={item.key} 
                onClick={() => onSelectKey?.(item.key)}
                className="cursor-pointer hover:opacity-80"
            >
              {/* Invisible larger hit area for easier clicking */}
              <circle cx={coords.x} cy={coords.y} r={12} fill="transparent" />
              
              <circle
                cx={coords.x}
                cy={coords.y}
                r={isSelected ? 6 : 3}
                fill={isSelected ? '#facc15' : '#64748b'}
                className="transition-all duration-300"
              />
              {isSelected && (
                 <text x={center} y={center} textAnchor="middle" fill="#facc15" fontSize="12" className="font-mono font-bold translate-y-1">
                  {item.key} ({item.size}KB)
                 </text>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const coords = getCoordinates(node.angle, 20);
          const isHealthy = node.status === NodeStatus.ONLINE;
          const isOverloaded = node.status === NodeStatus.OVERLOADED;
          
          // Determine base color
          let color = isHealthy ? '#4ade80' : '#ef4444'; // Green or Red
          if (isOverloaded) color = '#f97316'; // Orange
          if (node.status === NodeStatus.RECOVERING) color = '#3b82f6'; // Blue

          // Check if this node is a replica for the selected key
          const isReplica = selectedItem?.replicas.includes(node.id);
          const isPrimary = selectedItem?.primary === node.id;
          
          // Override color/style if replica
          if (isReplica) {
            color = '#facc15'; // Yellow
          }

          return (
            <g key={node.id} className="cursor-pointer hover:opacity-80 transition-opacity">
              {/* Connector line */}
              <line 
                x1={getCoordinates(node.angle, 0).x} 
                y1={getCoordinates(node.angle, 0).y}
                x2={coords.x}
                y2={coords.y}
                stroke={color}
                strokeWidth={isReplica ? "3" : "2"}
                strokeOpacity={isReplica ? 1 : 0.6}
              />
              {/* Node Circle */}
              <circle
                cx={coords.x}
                cy={coords.y}
                r={isReplica ? 14 : 12}
                fill="#1e293b"
                stroke={color}
                strokeWidth={isReplica ? 4 : 3}
                className="transition-all duration-300"
              />
              
              {/* Label: Node ID */}
              <text
                x={coords.x}
                y={coords.y}
                dy=".3em"
                textAnchor="middle"
                className={`text-[10px] font-bold pointer-events-none ${isReplica ? 'fill-yellow-400' : 'fill-white'}`}
              >
                {node.id}
              </text>

              {/* Label: Angle */}
              <text
                x={coords.x}
                y={coords.y + 26}
                textAnchor="middle"
                className="text-[10px] fill-slate-400"
              >
                {node.angle}°
              </text>

              {/* Label: Primary/Replica Badge */}
              {isReplica && (
                  <g>
                      <rect 
                        x={coords.x - 20} 
                        y={coords.y - 32} 
                        width="40" 
                        height="14" 
                        rx="4" 
                        fill="#0f172a" 
                        stroke={isPrimary ? '#facc15' : '#fbbf24'}
                        strokeWidth="1"
                      />
                      <text 
                        x={coords.x} 
                        y={coords.y - 23} 
                        textAnchor="middle" 
                        className={`text-[8px] font-bold ${isPrimary ? 'fill-yellow-400' : 'fill-amber-200'}`}
                      >
                        {isPrimary ? 'PRIMARY' : 'REPLICA'}
                      </text>
                  </g>
              )}
            </g>
          );
        })}

        {/* Traffic Animations */}
        {traffic.map((event) => {
          const targetNode = nodes.find(n => n.id === event.targetNodeId);
          if (!targetNode) return null;
          
          const targetCoords = getCoordinates(targetNode.angle, 20);
          
          let color = '#3b82f6'; // Blue (READ)
          if (event.type === 'WRITE') color = '#10b981'; // Green
          if (event.type === 'DELETE') color = '#ef4444'; // Red

          return (
            <circle key={event.id} r="4" fill={color} className="animate-traffic pointer-events-none">
              <animate
                attributeName="cx"
                from={center}
                to={targetCoords.x}
                dur="0.6s"
                fill="freeze"
                calcMode="spline"
                keySplines="0.4 0 0.2 1"
              />
              <animate
                attributeName="cy"
                from={center}
                to={targetCoords.y}
                dur="0.6s"
                fill="freeze"
                calcMode="spline"
                keySplines="0.4 0 0.2 1"
              />
              <animate
                attributeName="opacity"
                values="1;1;0"
                keyTimes="0;0.8;1"
                dur="0.6s"
                fill="freeze"
              />
            </circle>
          );
        })}
        
        {/* Decor */}
        <text x={center} y={center + radius + 40} textAnchor="middle" className="fill-slate-500 text-xs">
          Consistent Hash Ring (0-360°)
        </text>
      </svg>
    </div>
  );
};

export default HashRing;