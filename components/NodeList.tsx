import React from 'react';
import { Node, NodeStatus, DataItem } from '../types';
import { Server, Activity, RefreshCw, Power, Heart, Cpu, Database } from 'lucide-react';

interface NodeListProps {
  nodes: Node[];
  data: Record<string, DataItem>;
  onToggleStatus: (id: string) => void;
}

const NodeList: React.FC<NodeListProps> = ({ nodes, data, onToggleStatus }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {nodes.map((node) => {
         const isOnline = node.status === NodeStatus.ONLINE;
         // Normalize active requests for visualization (assuming 10 requests is "full" CPU for visual)
         const cpuLoad = Math.min(100, (node.activeRequests / 10) * 100);

         // Calculate Key Stats
         const totalKeys = node.dataKeys.length;
         const primaryCount = node.dataKeys.filter(k => data[k]?.primary === node.id).length;
         const replicaCount = totalKeys - primaryCount;

         return (
          <div 
            key={node.id} 
            className={`
              p-4 rounded-lg border flex flex-col gap-3 transition-colors relative overflow-hidden
              ${node.status === NodeStatus.ONLINE ? 'bg-slate-800 border-slate-700' : ''}
              ${node.status === NodeStatus.OFFLINE ? 'bg-red-950/30 border-red-900/50' : ''}
              ${node.status === NodeStatus.RECOVERING ? 'bg-blue-950/30 border-blue-900/50' : ''}
              ${node.status === NodeStatus.OVERLOADED ? 'bg-orange-950/30 border-orange-900/50' : ''}
            `}
          >
            {/* Health Check Pulse Background for Online Nodes */}
            {isOnline && (
                <div className="absolute top-2 right-2 flex items-center gap-1 opacity-40">
                    <span className="text-[9px] font-mono text-emerald-500 uppercase">Health OK</span>
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                    </span>
                </div>
            )}

            <div className="flex justify-between items-start z-10">
              <div className="flex items-center gap-2">
                <div className={`p-2 rounded-md ${isOnline ? 'bg-slate-700 text-green-400' : 'bg-red-900/20 text-red-400'}`}>
                  <Server size={20} />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-slate-200">{node.id}</h3>
                  <span className={`text-xs font-mono ${isOnline ? 'text-green-500' : 'text-red-500'}`}>
                    {node.status}
                  </span>
                </div>
              </div>
              <button 
                onClick={() => onToggleStatus(node.id)}
                className="text-slate-500 hover:text-slate-300 transition-colors z-20"
                title="Simulate Failure/Recovery"
              >
                {isOnline ? <Power size={18} /> : <RefreshCw size={18} />}
              </button>
            </div>

            {/* Metrics */}
            <div className="space-y-3 mt-2 z-10">
                
              {/* Storage Load */}
              <div className="space-y-1">
                <div className="flex justify-between items-center text-[10px] text-slate-400 uppercase tracking-wide">
                    <span className="flex items-center gap-1"><Database size={10}/> Storage</span>
                    <span className={node.load > 80 ? 'text-orange-400' : ''}>{Math.round(node.load)}%</span>
                </div>
                <div className="h-1.5 w-full bg-slate-700/50 rounded-full overflow-hidden">
                    <div 
                    className={`h-full rounded-full transition-all duration-500 ${node.load > 80 ? 'bg-orange-500' : 'bg-blue-500'}`} 
                    style={{ width: `${node.load}%` }}
                    />
                </div>
              </div>

              {/* CPU/Request Load */}
              <div className="space-y-1">
                 <div className="flex justify-between items-center text-[10px] text-slate-400 uppercase tracking-wide">
                    <span className="flex items-center gap-1"><Cpu size={10}/> CPU Load</span>
                    <span className={cpuLoad > 80 ? 'text-red-400' : 'text-emerald-400'}>{node.activeRequests} reqs</span>
                </div>
                <div className="h-1.5 w-full bg-slate-700/50 rounded-full overflow-hidden">
                    <div 
                    className={`h-full rounded-full transition-all duration-300 ${cpuLoad > 80 ? 'bg-red-500' : 'bg-emerald-500'}`} 
                    style={{ width: `${cpuLoad}%` }}
                    />
                </div>
              </div>

              {/* Data Keys Detailed Stats */}
              <div className="grid grid-cols-3 gap-1 pt-2 border-t border-slate-700/50 mt-2">
                  <div className="bg-slate-900/40 rounded p-1 text-center">
                    <div className="text-[9px] text-slate-500 uppercase font-bold">Total</div>
                    <div className="text-xs font-mono font-bold text-slate-300">{totalKeys}</div>
                  </div>
                  <div className="bg-indigo-950/30 rounded p-1 text-center border border-indigo-500/10">
                    <div className="text-[9px] text-indigo-400 uppercase font-bold">Primary</div>
                    <div className="text-xs font-mono font-bold text-indigo-300">{primaryCount}</div>
                  </div>
                  <div className="bg-amber-950/30 rounded p-1 text-center border border-amber-500/10">
                    <div className="text-[9px] text-amber-400 uppercase font-bold">Replica</div>
                    <div className="text-xs font-mono font-bold text-amber-300">{replicaCount}</div>
                  </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default NodeList;