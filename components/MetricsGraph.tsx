import React from 'react';
import { MetricPoint } from '../types';

interface MetricsGraphProps {
  data: MetricPoint[];
}

const MetricsGraph: React.FC<MetricsGraphProps> = ({ data }) => {
  if (data.length < 2) return <div className="h-24 flex items-center justify-center text-xs text-slate-600">Collecting metrics...</div>;

  const width = 100;
  const height = 50;
  const maxPoints = 20;

  // Normalize data to SVG coordinates
  const points = data.slice(-maxPoints).map((point, i, arr) => {
    const x = (i / (arr.length - 1)) * width;
    const y = height - (Math.min(point.avgCpu, 100) / 100) * height;
    return `${x},${y}`;
  }).join(' ');

  const storagePoints = data.slice(-maxPoints).map((point, i, arr) => {
    const x = (i / (arr.length - 1)) * width;
    // Normalize storage (assuming max expected storage for vis is somewhat arbitrary, e.g. 500KB or relative growth)
    // Here simply scaling it to fit graph roughly
    const y = height - (Math.min(point.storageUsage, 100) / 100) * height;
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className="w-full h-24 bg-slate-900/50 rounded border border-slate-800 p-2 relative overflow-hidden">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible" preserveAspectRatio="none">
        {/* Grid lines */}
        <line x1="0" y1="12.5" x2="100" y2="12.5" stroke="#1e293b" strokeWidth="0.5" />
        <line x1="0" y1="25" x2="100" y2="25" stroke="#1e293b" strokeWidth="0.5" />
        <line x1="0" y1="37.5" x2="100" y2="37.5" stroke="#1e293b" strokeWidth="0.5" />

        {/* CPU Line (Green/Red) */}
        <polyline
          fill="none"
          stroke="#10b981"
          strokeWidth="1.5"
          points={points}
          vectorEffect="non-scaling-stroke"
          className="drop-shadow-lg"
        />
        
        {/* Storage Line (Blue) */}
        <polyline
          fill="none"
          stroke="#3b82f6"
          strokeWidth="1.5"
          strokeDasharray="2"
          points={storagePoints}
          strokeOpacity="0.6"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      
      {/* Legend */}
      <div className="absolute top-1 right-2 flex gap-3">
        <div className="flex items-center gap-1">
            <div className="w-2 h-0.5 bg-emerald-500"></div>
            <span className="text-[8px] text-emerald-500 font-mono">CPU</span>
        </div>
        <div className="flex items-center gap-1">
            <div className="w-2 h-0.5 bg-blue-500 border-t border-dashed border-blue-500"></div>
            <span className="text-[8px] text-blue-500 font-mono">Storage</span>
        </div>
      </div>
    </div>
  );
};

export default MetricsGraph;
