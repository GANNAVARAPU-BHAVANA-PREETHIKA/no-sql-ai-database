
export enum NodeStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  RECOVERING = 'RECOVERING',
  OVERLOADED = 'OVERLOADED'
}

export interface Node {
  id: string;
  angle: number; // Position on the ring (0-360)
  status: NodeStatus;
  load: number; // Storage/Persistent Load (0-100)
  activeRequests: number; // Transient CPU/Request Load
  dataKeys: string[]; // Keys stored on this node
}

export interface DataItem {
  key: string;
  value: string; // The stored content
  size: number;
  hash: number; // 0-360
  replicas: string[]; // Node IDs where this data resides
  primary: string;
}

export type ConsistencyMode = 'STRONG' | 'EVENTUAL' | 'TUNABLE';

export interface SystemConfig {
  replicationFactor: number;
  readQuorum: number;
  writeQuorum: number;
  consistencyMode: ConsistencyMode;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  command: string;
  details: string;
  status: 'SUCCESS' | 'FAILURE' | 'WARNING';
  aiAnalysis?: string;
}

export interface LoadBalancerStats {
  totalRequests: number;
  lastRoute: string; // e.g., "Client -> N2"
  strategy: 'LEAST_LOADED' | 'ROUND_ROBIN';
}

export interface TrafficEvent {
  id: string;
  type: 'READ' | 'WRITE' | 'DELETE';
  targetNodeId: string;
  timestamp: number;
}

export interface MetricPoint {
  timestamp: number;
  avgCpu: number; // 0-100
  storageUsage: number; // 0-100 (normalized)
}

export interface SystemState {
  nodes: Node[];
  data: Record<string, DataItem>;
  config: SystemConfig;
  logs: LogEntry[];
  lbStats: LoadBalancerStats;
  traffic: TrafficEvent[];
  metricsHistory: MetricPoint[];
}
