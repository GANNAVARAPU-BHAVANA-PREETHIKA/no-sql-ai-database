import React, { useState, useEffect, useRef } from 'react';
import { utils, writeFile } from 'xlsx';
import { 
  SystemState, Node, NodeStatus, LogEntry, DataItem, TrafficEvent, ConsistencyMode 
} from './types';
import { 
  consistentHash, rebalanceData, checkQuorum, findResponsibleNodes 
} from './utils/simulationLogic';
import HashRing from './components/HashRing';
import NodeList from './components/NodeList';
import MetricsGraph from './components/MetricsGraph';
import { generateAIExplanation } from './services/geminiService';
import { 
  Terminal, Play, Plus, Database, ShieldAlert, Cpu, Server, Activity, 
  Scale, Settings, RefreshCw, Network, Zap, CheckCircle, AlertTriangle, 
  XCircle, Layers, Lock, Search, Edit, Trash2, Info, Download 
} from 'lucide-react';

interface BackendNode {
  node_id: string;
  capacity: number;
  used_storage: number;
  speed: string;
  status: 'active' | 'failed';
  remaining_capacity: number;
  utilization: string;
}

interface BackendConfig {
  consistency_mode: ConsistencyMode;
  replication_factor: number;
  read_quorum: number;
  write_quorum: number;
}

interface BackendShard {
  shard_id: string;
  node_id: string;
  size: number;
}

interface BackendReplica {
  id: number;
  shard_id: string;
  node_id: string;
  type: 'primary' | 'secondary';
}

interface BackendDataItem {
  item_key: string;
  item_value: string;
  size: number;
  shard_id: string;
  created_at: string;
  updated_at: string;
}

interface BackendState {
  nodes: BackendNode[];
  shards: BackendShard[];
  replicas: BackendReplica[];
  dataItems: BackendDataItem[];
  config?: BackendConfig;
  config_persisted?: boolean;
}

const INITIAL_STATE: SystemState = {
  nodes: [
    { id: 'N1', angle: 0, status: NodeStatus.ONLINE, load: 10, activeRequests: 0, dataKeys: [] },
    { id: 'N2', angle: 120, status: NodeStatus.ONLINE, load: 15, activeRequests: 0, dataKeys: [] },
    { id: 'N3', angle: 240, status: NodeStatus.ONLINE, load: 12, activeRequests: 0, dataKeys: [] },
  ],
  data: {},
  config: {
    replicationFactor: 3,
    readQuorum: 2,
    writeQuorum: 2,
    consistencyMode: 'TUNABLE'
  },
  logs: [],
  lbStats: {
    totalRequests: 0,
    lastRoute: 'Waiting...',
    strategy: 'LEAST_LOADED'
  },
  traffic: [],
  metricsHistory: []
};

type OpMode = 'CREATE' | 'READ' | 'UPDATE' | 'DELETE';

const App: React.FC = () => {
  const [state, setState] = useState<SystemState>(INITIAL_STATE);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [backendState, setBackendState] = useState<BackendState>({ nodes: [], shards: [], replicas: [], dataItems: [] });
  const [backendStatus, setBackendStatus] = useState('Backend not checked yet.');
  const [backendBusy, setBackendBusy] = useState(false);
  const [configPersistenceStatus, setConfigPersistenceStatus] = useState('Config is currently local to the simulator.');
  const hasLoadedBackendConfigRef = useRef(false);
  const latestConfigRef = useRef(INITIAL_STATE.config);
  
  // UI State
  const [opMode, setOpMode] = useState<OpMode>('CREATE');
  const [formKey, setFormKey] = useState('');
  const [formValue, setFormValue] = useState('');
  
  const [aiEnabled, setAiEnabled] = useState(false);
  const [autoRecovery, setAutoRecovery] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const callBackend = async (path: string, options?: RequestInit) => {
    const response = await fetch(path, {
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers || {}),
      },
      ...options,
    });

    let payload: any = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(payload.error || `Request failed with status ${response.status}`);
    }

    return payload;
  };

  const loadBackendState = async (silent: boolean = false) => {
    if (!silent) {
      setBackendBusy(true);
      setBackendStatus('Loading backend state...');
    }

    try {
      const payload = await callBackend('/api/getState', { method: 'GET' });
      setBackendState({
        nodes: payload.nodes || [],
        shards: payload.shards || [],
        replicas: payload.replicas || [],
        dataItems: payload.dataItems || [],
        config: payload.config,
        config_persisted: payload.config_persisted,
      });
      if (payload.config) {
        const shouldHydrateConfig = !hasLoadedBackendConfigRef.current || !silent;
        if (shouldHydrateConfig) {
          setState(prev => ({
            ...prev,
            config: {
              ...prev.config,
              replicationFactor: payload.config.replication_factor,
              readQuorum: payload.config.read_quorum,
              writeQuorum: payload.config.write_quorum,
              consistencyMode: payload.config.consistency_mode,
            }
          }));
          hasLoadedBackendConfigRef.current = true;
        }
      }
      setConfigPersistenceStatus(
        payload.config_persisted
          ? 'Config is saved in the backend database.'
          : 'Config table not found in Supabase yet, so settings are using fallback defaults.'
      );
      setBackendStatus(`Connected. ${payload.nodes?.length || 0} nodes, ${payload.shards?.length || 0} shards, and ${payload.dataItems?.length || 0} data items loaded.`);
    } catch (error: any) {
      setBackendStatus(
        error.message?.includes('Failed to fetch')
          ? 'Backend API is not reachable. Start the local Express server with npm run dev to use live backend sync.'
          : `Backend error: ${error.message}`
      );
      setConfigPersistenceStatus('Config persistence is unavailable while the backend is unreachable.');
    } finally {
      if (!silent) {
        setBackendBusy(false);
      }
    }
  };

  const deriveConfig = (
    currentConfig: SystemState['config'],
    key: keyof SystemState['config'],
    value: number | ConsistencyMode
  ) => {
    const nextConfig = { ...currentConfig, [key]: value };

    if (key === 'replicationFactor') {
      const n = value as number;
      nextConfig.replicationFactor = n;

      if (nextConfig.consistencyMode === 'STRONG') {
        nextConfig.writeQuorum = Math.floor(n / 2) + 1;
        nextConfig.readQuorum = Math.floor(n / 2) + 1;
      } else if (nextConfig.consistencyMode === 'EVENTUAL') {
        nextConfig.writeQuorum = 1;
        nextConfig.readQuorum = 1;
      } else {
        nextConfig.readQuorum = Math.min(nextConfig.readQuorum, n);
        nextConfig.writeQuorum = Math.min(nextConfig.writeQuorum, n);
      }
    }

    if (key === 'consistencyMode') {
      const mode = value as ConsistencyMode;
      const n = nextConfig.replicationFactor;
      nextConfig.consistencyMode = mode;

      if (mode === 'STRONG') {
        nextConfig.writeQuorum = Math.floor(n / 2) + 1;
        nextConfig.readQuorum = Math.floor(n / 2) + 1;
      } else if (mode === 'EVENTUAL') {
        nextConfig.writeQuorum = 1;
        nextConfig.readQuorum = 1;
      }
    }

    if (key === 'readQuorum') {
      nextConfig.readQuorum = Math.min(value as number, nextConfig.replicationFactor);
    }

    if (key === 'writeQuorum') {
      nextConfig.writeQuorum = Math.min(value as number, nextConfig.replicationFactor);
    }

    return nextConfig;
  };

  const syncConfigToBackend = async (config: SystemState['config']) => {
    try {
      const payload = await callBackend('/api/updateConfig', {
        method: 'POST',
        body: JSON.stringify({
          consistency_mode: config.consistencyMode,
          replication_factor: config.replicationFactor,
          read_quorum: config.readQuorum,
          write_quorum: config.writeQuorum,
        }),
      });

      setBackendState(prev => ({
        ...prev,
        config: payload.config,
        config_persisted: true,
      }));
      setConfigPersistenceStatus(
        `Saved row -> id=${payload.stored_row?.id}, mode=${payload.stored_row?.consistency_mode}, R=${payload.stored_row?.read_quorum}, W=${payload.stored_row?.write_quorum}, N=${payload.stored_row?.replication_factor}`
      );
      setBackendStatus(
        `Backend config saved: ${payload.config.consistency_mode} (R=${payload.config.read_quorum}, W=${payload.config.write_quorum}, N=${payload.config.replication_factor}).`
      );
      hasLoadedBackendConfigRef.current = true;
    } catch (error: any) {
      setConfigPersistenceStatus(`Config save failed: ${error.message}`);
      setBackendStatus(`Backend config save failed: ${error.message}`);
    }
  };

  const syncNodeToBackend = async (node: Node) => {
    try {
      await callBackend('/api/createNode', {
        method: 'POST',
        body: JSON.stringify({
          node_id: node.id,
          capacity: 100,
          speed: node.load > 60 ? 'fast' : 'normal',
        }),
      });
    } catch (error: any) {
      if (!String(error.message).toLowerCase().includes('duplicate')) {
        throw error;
      }
    }
  };

  const syncSimulatorNodesToBackend = async () => {
    setBackendBusy(true);
    setBackendStatus('Syncing simulator nodes to backend...');

    try {
      for (const node of state.nodes) {
        await syncNodeToBackend(node);
      }

      await loadBackendState(true);
      setBackendStatus(`Sync complete. ${state.nodes.length} simulator nodes pushed to backend.`);
    } catch (error: any) {
      setBackendStatus(`Sync failed: ${error.message}`);
    } finally {
      setBackendBusy(false);
    }
  };

  // Auto-scroll logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [state.logs]);

  useEffect(() => {
    loadBackendState(true);
  }, []);

  useEffect(() => {
    latestConfigRef.current = state.config;
  }, [state.config]);

  // --- 1. Metrics Collection Loop ---
  useEffect(() => {
      const interval = setInterval(() => {
          setState(prev => {
              // Decay Active Requests
              const updatedNodes = prev.nodes.map(n => ({
                  ...n,
                  activeRequests: Math.max(0, n.activeRequests - 1)
              }));

              // Collect Metrics
              const avgCpu = updatedNodes.reduce((acc, n) => acc + n.activeRequests, 0) / updatedNodes.length * 5;
              const totalSize = (Object.values(prev.data) as DataItem[]).reduce((acc, i) => acc + i.size, 0);
              const storageUsage = Math.min(100, (totalSize / 200) * 100);

              const newMetric = {
                  timestamp: Date.now(),
                  avgCpu: Math.min(100, avgCpu),
                  storageUsage
              };

              const updatedHistory = [...prev.metricsHistory, newMetric].slice(-30);

              return {
                  ...prev,
                  nodes: updatedNodes,
                  metricsHistory: updatedHistory
              };
          });
      }, 800); 

      return () => clearInterval(interval);
  }, []);

  // --- 2. Auto-Recovery Logic (Self-Healing) ---
  useEffect(() => {
    if (!autoRecovery) return;

    const interval = setInterval(() => {
        const offlineNode = state.nodes.find(n => n.status === NodeStatus.OFFLINE);
        if (offlineNode) {
            toggleNodeStatus(offlineNode.id);
        }
    }, 5000); 

    return () => clearInterval(interval);
  }, [autoRecovery, state.nodes]);

  // --- 3. Auto-Scaling Monitor Loop (Hotspot Detection) ---
  useEffect(() => {
      // Check frequently (200ms) to ensure immediate reaction to overload
      const monitorInterval = setInterval(() => {
          if (isProcessing) return;

          const OVERLOAD_THRESHOLD = 80;
          const overloadedNode = state.nodes.find(n => n.load >= OVERLOAD_THRESHOLD && n.status === NodeStatus.ONLINE);

          if (overloadedNode) {
              checkAndHandleOverload(state);
          }
      }, 200);

      return () => clearInterval(monitorInterval);
  }, [state, isProcessing]);


  const getClusterHealth = () => {
      const total = state.nodes.length;
      const offline = state.nodes.filter(n => n.status === NodeStatus.OFFLINE).length;
      const overloaded = state.nodes.filter(n => n.status === NodeStatus.OVERLOADED || n.load > 80).length;

      if (offline === 0 && overloaded === 0) return { status: 'HEALTHY', color: 'text-emerald-400', icon: CheckCircle };
      if (offline >= Math.ceil(total / 2)) return { status: 'CRITICAL', color: 'text-red-500', icon: XCircle };
      return { status: 'DEGRADED', color: 'text-amber-400', icon: AlertTriangle };
  };

  const health = getClusterHealth();
  const HealthIcon = health.icon;

  const triggerTraffic = (type: 'READ' | 'WRITE' | 'DELETE', targetNodeIds: string[]) => {
      const timestamp = Date.now();
      const newEvents: TrafficEvent[] = targetNodeIds.map((id, i) => ({
          id: `${timestamp}-${id}-${i}`,
          type,
          targetNodeId: id,
          timestamp
      }));

      setState(prev => ({
          ...prev,
          traffic: [...prev.traffic, ...newEvents]
      }));

      setTimeout(() => {
          setState(prev => ({
              ...prev,
              traffic: prev.traffic.filter(t => t.timestamp !== timestamp)
          }));
      }, 1000);
  };

  const addLog = async (command: string, details: string, status: 'SUCCESS' | 'FAILURE' | 'WARNING', prevState: SystemState, currentState?: SystemState) => {
    const entry: LogEntry = {
      id: Date.now().toString(),
      timestamp: Date.now(),
      command,
      details,
      status,
    };

    if (aiEnabled) {
        const newStateForLog = currentState || state;
        const optimisticLog = { ...entry, aiAnalysis: "Analyzing..." };
        setState(s => ({ ...s, logs: [...s.logs, optimisticLog] }));
        
        const analysis = await generateAIExplanation(command, details, prevState, newStateForLog);
        setState(s => ({
            ...s,
            logs: s.logs.map(l => l.id === entry.id ? { ...l, aiAnalysis: analysis } : l)
        }));
    } else {
        setState(prev => ({ ...prev, logs: [...prev.logs, entry] }));
    }
  };

  const updateConfig = (key: keyof typeof state.config, value: number | ConsistencyMode) => {
    const nextConfig = deriveConfig(latestConfigRef.current, key, value);
    latestConfigRef.current = nextConfig;
    setState(prev => ({
      ...prev,
      config: nextConfig
    }));
    setConfigPersistenceStatus('Saving config to backend...');
    syncConfigToBackend(nextConfig);
  };

  const checkAndHandleOverload = async (currentState: SystemState) => {
    const OVERLOAD_THRESHOLD = 80;
    const overloadedNode = currentState.nodes.find(n => n.load >= OVERLOAD_THRESHOLD && n.status === NodeStatus.ONLINE);

    if (overloadedNode) {
        setIsProcessing(true); 
        
        await addLog("AUTO-SCALE", `Node ${overloadedNode.id} reached ${Math.floor(overloadedNode.load)}% load. Initiating Split...`, "WARNING", currentState);
        
        setState(prev => ({
            ...prev,
            nodes: prev.nodes.map(n => n.id === overloadedNode.id ? { ...n, status: NodeStatus.OVERLOADED } : n)
        }));

        // Shorten delay for immediate feel
        await new Promise(r => setTimeout(r, 500));

        // Calculate New Topology
        const sortedNodes = [...currentState.nodes].sort((a,b) => a.angle - b.angle);
        const idx = sortedNodes.findIndex(n => n.id === overloadedNode.id);
        const prevNode = sortedNodes[(idx - 1 + sortedNodes.length) % sortedNodes.length];
        
        let newAngle = 0;

        // Special handling for single node or tight cluster
        if (sortedNodes.length === 1) {
             newAngle = (overloadedNode.angle + 180) % 360;
        } else {
            let startAngle = prevNode.angle;
            let endAngle = overloadedNode.angle;
            
            // Handle wrap-around (e.g., prev at 350, current at 10)
            if (startAngle >= endAngle) {
                endAngle += 360;
            }
            newAngle = (startAngle + endAngle) / 2 % 360;
        }
        
        const newId = `N${currentState.nodes.length + 1}`;

        const newNode: Node = {
            id: newId,
            angle: Math.floor(newAngle),
            status: NodeStatus.RECOVERING,
            load: 0,
            activeRequests: 0,
            dataKeys: []
        };
        
        setState(prev => ({
            ...prev,
            nodes: [...prev.nodes, newNode].map(n => n.id === overloadedNode.id ? { ...n, status: NodeStatus.OVERLOADED } : n)
        }));

        await addLog("AUTO-SCALE", `Spawning Node ${newId} at ${newNode.angle}°. Redistributing keys...`, "WARNING", currentState);
        
        // Fast rebalance
        await new Promise(r => setTimeout(r, 500)); 

        // Rebalance
        const stateForRebalance = { 
            ...currentState, 
            nodes: [...currentState.nodes, { ...newNode, status: NodeStatus.ONLINE }] 
        };

        const finalState = rebalanceData(stateForRebalance);
        
        // Final status fix-up
        finalState.nodes = finalState.nodes.map(n => {
            if (n.id === overloadedNode.id) return { ...n, status: NodeStatus.ONLINE };
            if (n.id === newId) return { ...n, status: NodeStatus.ONLINE };
            return n;
        });

        setState(finalState);
        await addLog(
            "AUTO-SCALE", 
            `Split Complete. Load balanced between ${overloadedNode.id} and ${newId}.`, 
            "SUCCESS", 
            currentState,
            finalState
        );
        
        setIsProcessing(false);
    }
  };

  const calculateSize = (val: string) => {
    return Math.max(5, Math.ceil(val.length / 5));
  };

  const handleInsert = async (key: string, value: string, command: string = 'INSERT') => {
    const prevState = { ...state };
    
    const existingItem = state.data[key];
    const size = calculateSize(value);

    const hash = consistentHash(key);
    
    const replicas = findResponsibleNodes(state.nodes, hash, state.config.replicationFactor);
    const primary = replicas[0];

    if (!checkQuorum(replicas, state.config.writeQuorum)) {
      await addLog(`${command} ${key}`, `Write Quorum (${state.config.writeQuorum}) Failed. Available: ${replicas.filter(n => n.status === NodeStatus.ONLINE).length}`, 'FAILURE', prevState);
      return;
    }

    const newItem: DataItem = {
      key,
      value,
      size,
      hash,
      replicas: replicas.map(n => n.id),
      primary: primary.id
    };

    const targetNodeIds = replicas.map(n => n.id);
    triggerTraffic('WRITE', targetNodeIds);

    const newState = {
      ...state,
      data: { ...state.data, [key]: newItem },
      lbStats: {
        ...state.lbStats,
        totalRequests: state.lbStats.totalRequests + 1,
        lastRoute: `Client → LB → ${primary.id} (Primary)`
      }
    };

    newState.nodes = newState.nodes.map(n => {
       if (newItem.replicas.includes(n.id)) {
         // Load impact logic: raw size for easier simulation (previously size/5)
         const oldLoad = existingItem && existingItem.replicas.includes(n.id) ? existingItem.size : 0;
         const newDataKeys = n.dataKeys.includes(key) ? n.dataKeys : [...n.dataKeys, key];

         return { 
             ...n, 
             load: Math.max(0, n.load - oldLoad + size), // Increased impact
             activeRequests: n.activeRequests + 2, 
             dataKeys: newDataKeys
         };
       }
       return n;
    });

    setState(newState);
    setSelectedKey(key);
    await addLog(`${command} ${key}`, `LB routed write to Primary [${primary.id}]. Replicated to [${newItem.replicas.join(', ')}]`, 'SUCCESS', prevState, newState);

    const backendPath = command === 'UPDATE' ? '/api/updateData' : '/api/insertData';

    try {
      await callBackend(backendPath, {
        method: 'POST',
        body: JSON.stringify({ key, value, size }),
      });
      await loadBackendState(true);
      setBackendStatus(`Backend ${command === 'UPDATE' ? 'updated' : 'inserted'} key ${key}.`);
    } catch (error: any) {
      setBackendStatus(`Simulator write succeeded, but backend ${command === 'UPDATE' ? 'update' : 'insert'} did not: ${error.message}`);
    }
  };

  const handleRead = async (key: string) => {
     const prevState = { ...state };
     const item = state.data[key];
     
     if (!item) {
       await addLog(`READ ${key}`, `Key not found`, 'FAILURE', prevState);
       return;
     }

     const responsibleNodes = state.nodes.filter(n => item.replicas.includes(n.id));
     
     if (!checkQuorum(responsibleNodes, state.config.readQuorum)) {
        await addLog(`READ ${key}`, `Read Quorum (${state.config.readQuorum}) Failed. Healthy owners: ${responsibleNodes.filter(n => n.status === NodeStatus.ONLINE).length}`, 'FAILURE', prevState);
        return;
     }

     const healthyCandidates = responsibleNodes.filter(n => n.status === NodeStatus.ONLINE);
     healthyCandidates.sort((a, b) => a.activeRequests - b.activeRequests);
     const bestReplica = healthyCandidates[0];

     triggerTraffic('READ', [bestReplica.id]);

     const newState = {
         ...state,
         lbStats: {
             ...state.lbStats,
             totalRequests: state.lbStats.totalRequests + 1,
             lastRoute: `Client → LB → ${bestReplica.id} (Active Reqs: ${bestReplica.activeRequests})`
         }
     };

     newState.nodes = newState.nodes.map(n => 
        n.id === bestReplica.id ? { ...n, activeRequests: n.activeRequests + 1 } : n
     );

     setState(newState);
     setSelectedKey(key);
     
     const valDisp = item.value.length > 30 ? item.value.substring(0, 30) + '...' : item.value;
     await addLog(`READ ${key}`, `Value: "${valDisp}". Served by ${bestReplica.id}.`, 'SUCCESS', prevState, newState);

     try {
       const backendRead = await callBackend(`/api/readData?key=${encodeURIComponent(key)}`, { method: 'GET' });
       const backendValue = String(backendRead.item?.item_value || '');
       const backendDisp = backendValue.length > 30 ? `${backendValue.substring(0, 30)}...` : backendValue;
       setBackendStatus(`Backend read OK for ${key}: "${backendDisp}"`);
       await loadBackendState(true);
     } catch (error: any) {
       setBackendStatus(`Simulator read succeeded, but backend read did not: ${error.message}`);
     }
  };

  const handleDelete = async (key: string) => {
    const prevState = { ...state };
    const item = state.data[key];

    if (!item) {
       await addLog(`DELETE ${key}`, `Key not found`, 'FAILURE', prevState);
       return;
    }

    const responsibleNodes = state.nodes.filter(n => item.replicas.includes(n.id));
    
    if (!checkQuorum(responsibleNodes, state.config.writeQuorum)) {
       await addLog(`DELETE ${key}`, `Write Quorum (${state.config.writeQuorum}) Failed. Healthy owners: ${responsibleNodes.filter(n => n.status === NodeStatus.ONLINE).length}`, 'FAILURE', prevState);
       return;
    }

    const primaryId = item.primary;
    
    triggerTraffic('DELETE', item.replicas);

    const newState = {
        ...state,
        lbStats: {
             ...state.lbStats,
             totalRequests: state.lbStats.totalRequests + 1,
             lastRoute: `Client → LB → ${primaryId} (Primary) → Delete`
        }
    };

    const newData = { ...newState.data };
    delete newData[key];
    newState.data = newData;

    newState.nodes = newState.nodes.map(n => {
       if (item.replicas.includes(n.id)) {
         return { 
             ...n, 
             load: Math.max(0, n.load - item.size), // Updated to match Insert logic
             activeRequests: n.activeRequests + 1,
             dataKeys: n.dataKeys.filter(k => k !== key)
         };
       }
       return n;
    });

    if (selectedKey === key) setSelectedKey(null);

    setState(newState);
    await addLog(`DELETE ${key}`, `Key removed from [${item.replicas.join(', ')}]`, 'SUCCESS', prevState, newState);

    try {
      await callBackend('/api/deleteData', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
      await loadBackendState(true);
      setBackendStatus(`Backend deleted key ${key}.`);
    } catch (error: any) {
      setBackendStatus(`Simulator delete succeeded, but backend delete did not: ${error.message}`);
    }
  };

  const handleAddNode = async () => {
    const prevState = { ...state };
    const newId = `N${state.nodes.length + 1}`;
    
    let maxGap = 0;
    let bestAngle = (state.nodes[state.nodes.length-1]?.angle + 60) % 360 || 0;
    
    if (state.nodes.length > 0) {
        const sorted = [...state.nodes].sort((a,b) => a.angle - b.angle);
        for(let i=0; i<sorted.length; i++) {
            const current = sorted[i].angle;
            const next = sorted[(i+1)%sorted.length].angle;
            let gap = next - current;
            if (gap < 0) gap += 360;
            if (gap > maxGap) {
                maxGap = gap;
                bestAngle = (current + gap / 2) % 360;
            }
        }
    }

    const newNode: Node = {
      id: newId,
      angle: Math.floor(bestAngle),
      status: NodeStatus.ONLINE,
      load: 5,
      activeRequests: 0,
      dataKeys: []
    };

    const tempState = { ...state, nodes: [...state.nodes, newNode] };
    const rebalancedState = rebalanceData(tempState);
    
    setState(rebalancedState);
    await addLog(`ADD NODE ${newId}`, `Manual add at ${newNode.angle}°. Shards rebalanced.`, 'SUCCESS', prevState, rebalancedState);

    try {
      await syncNodeToBackend(newNode);
      await loadBackendState(true);
      setBackendStatus(`Backend node ${newId} created.`);
    } catch (error: any) {
      setBackendStatus(`Simulator node added, but backend create failed: ${error.message}`);
    }
  };

  const toggleNodeStatus = async (id: string) => {
    const prevState = { ...state };
    const targetNode = state.nodes.find(n => n.id === id);
    if (!targetNode) return;

    let newStatus = NodeStatus.ONLINE;
    let logMsg = '';

    if (targetNode.status === NodeStatus.ONLINE) {
        newStatus = NodeStatus.OFFLINE;
        logMsg = `Node ${id} Failed (Simulated).`;
    } else {
        newStatus = NodeStatus.ONLINE;
        logMsg = `Node ${id} Recovered/Restarted.`;
    }
    
    const updatedNodes = state.nodes.map(n => 
      n.id === id ? { ...n, status: newStatus } : n
    );

    const tempState = { ...state, nodes: updatedNodes };
    const finalState = newStatus === NodeStatus.ONLINE ? rebalanceData(tempState) : tempState;

    setState(finalState);
    await addLog(
        newStatus === NodeStatus.ONLINE ? `RECOVERY ${id}` : `FAILURE ${id}`, 
        logMsg, 
        'WARNING',
        prevState,
        finalState
    );

    try {
      await callBackend(newStatus === NodeStatus.ONLINE ? '/api/resetNode' : '/api/simulateFailure', {
        method: 'POST',
        body: JSON.stringify({ node_id: id }),
      });
      await loadBackendState(true);
      setBackendStatus(`Backend node ${id} marked as ${newStatus === NodeStatus.ONLINE ? 'active' : 'failed'}.`);
    } catch (error: any) {
      setBackendStatus(`Simulator node status changed, but backend sync failed: ${error.message}`);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formKey.trim()) return;
    setIsProcessing(true);

    try {
        switch (opMode) {
            case 'CREATE':
                await handleInsert(formKey, formValue || `{"name":"User${Math.floor(Math.random()*1000)}"}`);
                break;
            case 'READ':
                await handleRead(formKey);
                break;
            case 'UPDATE':
                await handleInsert(formKey, formValue || `{"updated": true, "ts": ${Date.now()}}`, 'UPDATE');
                break;
            case 'DELETE':
                await handleDelete(formKey);
                break;
        }
        setFormKey('');
        setFormValue('');
    } catch (err: any) {
        await addLog(opMode, err.message, 'FAILURE', state);
    }
    setIsProcessing(false);
  };

  const handleExportExcel = () => {
    const rows = Object.values(state.data).map(item => ({
      Key: item.key,
      Value: item.value,
      Size_KB: item.size,
      Hash_Angle: item.hash,
      Primary_Node: item.primary,
      Replicas: item.replicas.join(', ')
    }));

    if (rows.length === 0) {
        addLog("EXPORT", "No data available to export.", "WARNING", state);
        return;
    }

    const worksheet = utils.json_to_sheet(rows);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, "NoSQL Data");
    writeFile(workbook, "nosql-data-export.xlsx");
    addLog("EXPORT", "Data exported to Excel successfully.", "SUCCESS", state);
  };

  const getModeDetails = (mode: ConsistencyMode) => {
    switch (mode) {
        case 'STRONG':
            return {
                title: "Strong Consistency",
                desc: "Strict Consistency (CP). Guarantees most recent write.",
                subDesc: "R + W > N. Tolerates fewer failures, higher latency.",
                guarantees: "Latest committed read is guaranteed.",
                tradeoff: "Better correctness, lower availability during failures.",
                color: "bg-indigo-600",
                activeClass: "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20 ring-1 ring-indigo-400"
            };
        case 'EVENTUAL':
            return {
                title: "Eventual Consistency",
                desc: "High Availability (AP). Fast reads, eventual consistency.",
                subDesc: "R=1, W=1. Minimizes latency, but risk of stale data.",
                guarantees: "Replicas converge after propagation.",
                tradeoff: "Best availability and speed, but stale reads are possible.",
                color: "bg-emerald-600",
                activeClass: "bg-emerald-600 text-white shadow-lg shadow-emerald-500/20 ring-1 ring-emerald-400"
            };
        case 'TUNABLE':
            return {
                title: "Tunable Consistency",
                desc: "Custom Configuration. Balance performance vs consistency.",
                subDesc: "Manually adjust Quorums (R/W) based on needs.",
                guarantees: "Depends on the quorum values you choose.",
                tradeoff: "Lets you tune latency vs correctness per workload.",
                color: "bg-slate-600",
                activeClass: "bg-slate-600 text-white shadow-lg shadow-slate-500/20 ring-1 ring-slate-400"
            };
    }
  };

  const currentMode = getModeDetails(state.config.consistencyMode);
  const isStrong = (state.config.readQuorum + state.config.writeQuorum) > state.config.replicationFactor;
  const consistencyCards = (['STRONG', 'EVENTUAL', 'TUNABLE'] as ConsistencyMode[]).map((mode) => ({
    mode,
    details: getModeDetails(mode),
  }));

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-slate-900 border-b border-slate-800 p-4 shadow-md z-20">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="flex items-center gap-3">
                <div className="bg-indigo-600 p-2 rounded-lg shadow-lg shadow-indigo-500/20">
                    <Database className="text-white" size={24} />
                </div>
                <div>
                    <h1 className="text-xl font-bold tracking-tight text-white">NoSQL-Sim AI</h1>
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                        <span>Cluster Status:</span>
                        <span className={`font-mono font-bold flex items-center gap-1 ${health.color}`}>
                            <HealthIcon size={12} />
                            {health.status}
                        </span>
                    </div>
                </div>
            </div>
            
            <div className="flex items-center gap-4">
                 <button 
                    onClick={() => setShowConfig(!showConfig)}
                    className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-md border transition-all ${showConfig ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}
                 >
                    <Settings size={14} /> Config
                 </button>
                 <button 
                    onClick={handleExportExcel}
                    className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-md border border-emerald-700 bg-emerald-900/30 text-emerald-400 hover:bg-emerald-900/50 transition-all"
                    title="Download Data as Excel"
                 >
                    <Download size={14} /> Export
                 </button>
                 <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-300 select-none hover:bg-slate-800 px-2 py-1 rounded border border-transparent hover:border-slate-700 transition-colors">
                    <input 
                        type="checkbox" 
                        checked={aiEnabled} 
                        onChange={e => setAiEnabled(e.target.checked)}
                        className="form-checkbox h-4 w-4 text-indigo-600 rounded bg-slate-800 border-slate-700 focus:ring-indigo-500"
                    />
                    <span className="flex items-center gap-1.5"><Cpu size={14} className="text-indigo-400"/> AI Analysis</span>
                </label>
                 <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-300 select-none hover:bg-slate-800 px-2 py-1 rounded border border-transparent hover:border-slate-700 transition-colors">
                    <input 
                        type="checkbox" 
                        checked={autoRecovery} 
                        onChange={e => setAutoRecovery(e.target.checked)}
                        className="form-checkbox h-4 w-4 text-emerald-600 rounded bg-slate-800 border-slate-700 focus:ring-emerald-500"
                    />
                    <span className="flex items-center gap-1.5"><Zap size={14} className="text-emerald-400"/> Auto-Recovery</span>
                </label>
            </div>
        </div>

        {/* Config Panel */}
        {showConfig && (
            <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 animate-in slide-in-from-top-2">
                <div className="mb-4">
                     <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                        <Layers size={14} /> Consistency Mode
                     </label>
                     <div className="grid grid-cols-3 gap-2 bg-slate-900/50 p-1 rounded-lg">
                        {(['STRONG', 'EVENTUAL', 'TUNABLE'] as ConsistencyMode[]).map((mode) => {
                            const details = getModeDetails(mode);
                            return (
                                <button
                                    key={mode}
                                    onClick={() => updateConfig('consistencyMode', mode)}
                                    className={`
                                        py-2 px-3 rounded-md text-xs font-bold transition-all
                                        ${state.config.consistencyMode === mode 
                                            ? details.activeClass
                                            : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
                                        }
                                    `}
                                >
                                    {mode}
                                </button>
                            );
                        })}
                     </div>
                     {/* Dynamic Explanation */}
                     <div className="mt-3 bg-slate-900/60 rounded p-3 border border-slate-700/50 flex items-start gap-3">
                        <div className={`mt-0.5 p-1 rounded-full ${state.config.consistencyMode === 'STRONG' ? 'bg-indigo-500/20 text-indigo-400' : state.config.consistencyMode === 'EVENTUAL' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-400'}`}>
                             <Info size={14} />
                        </div>
                        <div>
                            <div className="text-xs font-bold text-slate-200">{currentMode.title}</div>
                            <div className="text-[10px] text-slate-400 mt-0.5">{currentMode.desc}</div>
                            <div className="text-[10px] text-slate-500 mt-1">{currentMode.subDesc}</div>
                            <div className="text-[10px] text-slate-500 mt-1">{currentMode.guarantees}</div>
                        </div>
                     </div>
                     <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${
                        configPersistenceStatus.toLowerCase().includes('failed')
                          ? 'border-red-500/40 bg-red-950/30 text-red-300'
                          : configPersistenceStatus.toLowerCase().includes('saved')
                            ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                            : 'border-slate-700/60 bg-slate-900/60 text-slate-300'
                     }`}>
                        <div className="text-[10px] font-semibold uppercase tracking-wider opacity-75">Config Save Status</div>
                        <div className="mt-1">{configPersistenceStatus}</div>
                     </div>
                     <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                        {consistencyCards.map(({ mode, details }) => (
                          <div
                            key={mode}
                            className={`rounded-lg border p-3 ${
                              state.config.consistencyMode === mode
                                ? 'border-cyan-500/50 bg-slate-900/80'
                                : 'border-slate-700/60 bg-slate-900/40'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-xs font-bold text-white">{mode}</div>
                              <span className={`text-[10px] px-2 py-0.5 rounded-full ${details.color} text-white`}>
                                {mode === 'STRONG' ? 'CP' : mode === 'EVENTUAL' ? 'AP' : 'Custom'}
                              </span>
                            </div>
                            <div className="mt-2 text-[11px] text-slate-300">{details.desc}</div>
                            <div className="mt-2 text-[10px] text-slate-500">{details.subDesc}</div>
                            <div className="mt-2 text-[10px] text-slate-400">
                              {mode === 'STRONG' && 'Reads return the latest committed write.'}
                              {mode === 'EVENTUAL' && 'Reads may be stale until replicas catch up.'}
                              {mode === 'TUNABLE' && 'Behavior changes with the quorum values you choose.'}
                            </div>
                          </div>
                        ))}
                     </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4 border-t border-slate-700/50">
                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Replication Factor (N)</label>
                        <div className="flex items-center gap-3">
                            <input 
                                type="range" min="1" max="5" 
                                value={state.config.replicationFactor} 
                                onChange={(e) => updateConfig('replicationFactor', parseInt(e.target.value))}
                                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                            />
                            <span className="font-mono text-lg font-bold w-6">{state.config.replicationFactor}</span>
                        </div>
                    </div>
                    <div className="space-y-2 relative group">
                        <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                            Read Quorum (R)
                            {state.config.consistencyMode !== 'TUNABLE' && <Lock size={10} className="text-slate-500"/>}
                        </label>
                        <div className={`flex items-center gap-3 ${state.config.consistencyMode !== 'TUNABLE' ? 'opacity-50 grayscale pointer-events-none' : ''}`}>
                            <input 
                                type="range" min="1" max={state.config.replicationFactor} 
                                value={state.config.readQuorum} 
                                onChange={(e) => updateConfig('readQuorum', parseInt(e.target.value))}
                                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                disabled={state.config.consistencyMode !== 'TUNABLE'}
                            />
                            <span className="font-mono text-lg font-bold w-6">{state.config.readQuorum}</span>
                        </div>
                    </div>
                    <div className="space-y-2 relative group">
                        <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                            Write Quorum (W)
                            {state.config.consistencyMode !== 'TUNABLE' && <Lock size={10} className="text-slate-500"/>}
                        </label>
                        <div className={`flex items-center gap-3 ${state.config.consistencyMode !== 'TUNABLE' ? 'opacity-50 grayscale pointer-events-none' : ''}`}>
                            <input 
                                type="range" min="1" max={state.config.replicationFactor} 
                                value={state.config.writeQuorum} 
                                onChange={(e) => updateConfig('writeQuorum', parseInt(e.target.value))}
                                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                                disabled={state.config.consistencyMode !== 'TUNABLE'}
                            />
                            <span className="font-mono text-lg font-bold w-6">{state.config.writeQuorum}</span>
                        </div>
                    </div>
                </div>
                
                {/* Equation Visualizer */}
                <div className="mt-4 pt-4 border-t border-slate-700/50 flex justify-center">
                    <div className={`px-4 py-2 rounded-lg border ${isStrong ? 'bg-indigo-950/30 border-indigo-500/30' : 'bg-emerald-950/30 border-emerald-500/30'} flex items-center gap-3`}>
                        <div className="font-mono text-sm">
                            <span className="text-blue-400 font-bold">R({state.config.readQuorum})</span>
                            <span className="text-slate-400 mx-1">+</span>
                            <span className="text-emerald-400 font-bold">W({state.config.writeQuorum})</span>
                            <span className="text-slate-400 mx-1">{isStrong ? '>' : '≤'}</span>
                            <span className="text-indigo-400 font-bold">N({state.config.replicationFactor})</span>
                        </div>
                        <div className={`text-xs font-bold px-2 py-0.5 rounded ${isStrong ? 'bg-indigo-500 text-white' : 'bg-emerald-500 text-white'}`}>
                            {isStrong ? 'Strong Consistency' : 'Weak Consistency'}
                        </div>
                    </div>
                </div>
                <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3 pt-4 border-t border-slate-700/50">
                    <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">Mode</div>
                        <div className="mt-1 text-sm font-semibold text-white">{state.config.consistencyMode}</div>
                    </div>
                    <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">Quorum Rule</div>
                        <div className="mt-1 text-sm font-semibold text-white">R={state.config.readQuorum}, W={state.config.writeQuorum}, N={state.config.replicationFactor}</div>
                    </div>
                    <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">Latest Read</div>
                        <div className="mt-1 text-sm font-semibold text-white">{isStrong ? 'Guaranteed' : 'Not guaranteed'}</div>
                    </div>
                    <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">Stale Reads</div>
                        <div className="mt-1 text-sm font-semibold text-white">{isStrong ? 'Unlikely under quorum' : 'Possible'}</div>
                    </div>
                </div>
            </div>
        )}
      </header>

      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 overflow-hidden">
        
        {/* Left Column: Visualization & Controls */}
        <div className="lg:col-span-8 flex flex-col gap-6">
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                 {/* Load Balancer Panel */}
                <div className="md:col-span-1 bg-gradient-to-br from-indigo-950/50 to-slate-900/50 rounded-xl border border-indigo-500/30 p-4 shadow-lg flex flex-col justify-between relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-2 opacity-10"><Network size={80} /></div>
                    <div className="flex items-center gap-2 mb-2 text-[10px] text-indigo-300 font-bold uppercase tracking-widest bg-indigo-900/30 w-fit px-2 py-0.5 rounded">Layer: Middleware</div>
                    <div>
                        <h2 className="text-sm font-semibold text-indigo-300 flex items-center gap-2 mb-3">
                            <Network size={16} /> Load Balancer
                        </h2>
                        <div className="space-y-3">
                            <div>
                                <div className="text-[10px] text-indigo-400 uppercase tracking-wider">Strategy</div>
                                <div className="text-sm font-mono text-white flex items-center gap-1">
                                    <Scale size={12} className="text-emerald-400"/> Least Loaded Replica
                                </div>
                            </div>
                            <div>
                                <div className="text-[10px] text-indigo-400 uppercase tracking-wider">Last Route</div>
                                <div className="text-xs font-mono text-slate-300 bg-black/40 p-2 rounded border border-indigo-500/20 truncate">
                                    {state.lbStats.lastRoute}
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="mt-4 pt-3 border-t border-indigo-500/20 flex justify-between items-end">
                        <span className="text-[10px] text-indigo-400">Total Requests</span>
                        <span className="text-2xl font-bold text-white font-mono">{state.lbStats.totalRequests}</span>
                    </div>
                </div>

                {/* Hash Ring */}
                <div className="md:col-span-2 bg-slate-900/50 rounded-xl border border-slate-800 p-4 flex flex-col shadow-inner min-h-[300px] relative">
                    <div className="absolute top-4 left-4 flex items-center gap-2 text-[10px] text-slate-500 font-bold uppercase tracking-widest bg-slate-800/50 px-2 py-0.5 rounded">Layer: Data Storage</div>
                    <div className="flex-1 flex justify-center items-center">
                        <HashRing 
                            nodes={state.nodes} 
                            data={state.data} 
                            traffic={state.traffic}
                            selectedKey={selectedKey}
                            onSelectKey={setSelectedKey}
                        />
                    </div>
                </div>
            </div>

            <div className="space-y-4">
                <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4 relative">
                    <div className="absolute top-4 right-4 text-[10px] text-slate-500 font-bold uppercase tracking-widest bg-slate-800 px-2 py-0.5 rounded">Module: Monitoring</div>
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="text-sm font-semibold text-slate-400 flex items-center gap-2">
                            <Server size={16} /> Node Status
                        </h2>
                        <span className="text-[10px] text-slate-500 bg-slate-800 px-2 py-1 rounded-full flex items-center gap-1">
                            <Activity size={10} className="animate-pulse text-green-500"/> Health Check Active
                        </span>
                    </div>
                    <NodeList nodes={state.nodes} data={state.data} onToggleStatus={toggleNodeStatus} />
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                    <button 
                        onClick={() => handleAddNode()}
                        disabled={isProcessing}
                        className="py-3 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-all disabled:opacity-50 shadow-lg shadow-indigo-900/20"
                    >
                        <Plus size={18} /> Add Node
                    </button>
                    <button 
                            onClick={() => handleInsert(`user:${Math.floor(Math.random()*1000)}`, `{"data": "random_${Date.now()}"}`)}
                            disabled={isProcessing}
                            className="py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-all disabled:opacity-50 shadow-lg shadow-emerald-900/20"
                    >
                        <Play size={18} /> Rand Insert
                    </button>
                </div>
            </div>

            {/* Database Operations Tabbed UI */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-5 shadow-xl flex flex-col gap-4 relative">
                <div className="absolute top-3 right-3 text-[10px] text-slate-500 font-bold uppercase tracking-widest bg-slate-800 px-2 py-0.5 rounded">Layer: Client</div>
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <Terminal size={18} className="text-indigo-400"/> Database Operations
                  </h2>
                  <p className="text-slate-400 text-xs mt-1">Perform CRUD operations on the distributed cluster</p>
                </div>

                {/* Tabs */}
                <div className="flex bg-slate-800/50 rounded-lg p-1 gap-1">
                  <button 
                    onClick={() => { setOpMode('CREATE'); setFormValue(''); }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all ${opMode === 'CREATE' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                  >
                    <Plus size={14} /> Create
                  </button>
                  <button 
                    onClick={() => { setOpMode('READ'); setFormValue(''); }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all ${opMode === 'READ' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                  >
                    <Search size={14} /> Read
                  </button>
                  <button 
                    onClick={() => { setOpMode('UPDATE'); setFormValue(''); }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all ${opMode === 'UPDATE' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                  >
                    <Edit size={14} /> Update
                  </button>
                  <button 
                    onClick={() => { setOpMode('DELETE'); setFormValue(''); }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all ${opMode === 'DELETE' ? 'bg-red-600 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>

                {/* Form Fields */}
                <form onSubmit={handleFormSubmit} className="flex flex-col gap-4 bg-slate-800/20 p-4 rounded-lg border border-slate-700/30">
                   <div className="space-y-1.5">
                     <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Key</label>
                     <input 
                        type="text" 
                        value={formKey}
                        onChange={e => setFormKey(e.target.value)}
                        placeholder="e.g., user:1001"
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all placeholder-slate-600"
                        disabled={isProcessing}
                     />
                   </div>

                   {(opMode === 'CREATE' || opMode === 'UPDATE') && (
                     <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1">
                       <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Value (JSON or text)</label>
                       <input 
                          type="text" 
                          value={formValue}
                          onChange={e => setFormValue(e.target.value)}
                          placeholder='{"name": "Alice", "age": 28}'
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all placeholder-slate-600"
                          disabled={isProcessing}
                       />
                     </div>
                   )}

                   <button 
                    type="submit"
                    disabled={isProcessing || !formKey.trim()}
                    className={`
                      w-full py-2.5 rounded-lg text-sm font-bold shadow-lg transition-all flex items-center justify-center gap-2
                      disabled:opacity-50 disabled:cursor-not-allowed
                      ${opMode === 'DELETE' 
                        ? 'bg-red-600 hover:bg-red-700 shadow-red-900/20' 
                        : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-900/20'
                      }
                    `}
                   >
                      {isProcessing ? (
                        <RefreshCw className="animate-spin" size={16} />
                      ) : (
                         <>
                            {opMode === 'CREATE' && <Plus size={16} />}
                            {opMode === 'READ' && <Search size={16} />}
                            {opMode === 'UPDATE' && <Edit size={16} />}
                            {opMode === 'DELETE' && <Trash2 size={16} />}
                            {opMode} Data
                         </>
                      )}
                   </button>
                </form>
            </div>
        </div>

        {/* Right Column: Logs & State */}
        <div className="lg:col-span-4 flex flex-col gap-6 h-full overflow-hidden">
            <div className="flex-1 bg-slate-900 rounded-xl border border-slate-800 flex flex-col overflow-hidden shadow-lg">
                <div className="p-3 border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10 flex justify-between items-center">
                    <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                        <Activity size={16} /> Operation Log
                    </h2>
                    <span className="text-[10px] text-slate-600 font-mono">{state.logs.length} events</span>
                </div>
                <div ref={logContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-xs">
                    {state.logs.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-2">
                            <Terminal size={24} className="opacity-20" />
                            <p>System ready. Waiting for commands...</p>
                        </div>
                    )}
                    {state.logs.map((log) => (
                        <div key={log.id} className="group relative pl-3 py-1 border-l-2 border-slate-700 hover:border-indigo-500 transition-colors">
                            <div className="flex justify-between items-start mb-1">
                                <span className="font-bold text-slate-200">{log.command}</span>
                                <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide ${
                                    log.status === 'SUCCESS' ? 'bg-emerald-950 text-emerald-400' : 
                                    log.status === 'FAILURE' ? 'bg-red-950 text-red-400' : 
                                    'bg-amber-950 text-amber-400'
                                }`}>
                                    {log.status}
                                </span>
                            </div>
                            <div className="text-slate-400 leading-relaxed break-words">{log.details}</div>
                            {log.aiAnalysis && (
                                <div className="mt-2 p-2 bg-gradient-to-br from-indigo-950/40 to-slate-900/40 rounded border border-indigo-500/20 text-indigo-300/90 leading-relaxed shadow-sm">
                                    <div className="flex items-center gap-1.5 mb-1 text-indigo-400 font-semibold uppercase text-[9px] tracking-wider">
                                        <Cpu size={10} /> AI Insight
                                    </div>
                                    {log.aiAnalysis}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            <div className="shrink-0 bg-slate-900 rounded-xl border border-slate-800 flex flex-col overflow-hidden">
                 <div className="p-3 border-b border-slate-800">
                    <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                        <ShieldAlert size={16} /> Cluster Metrics
                    </h2>
                </div>
                <div className="p-4 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="bg-slate-800/30 p-3 rounded-lg text-center border border-slate-700/50">
                            <div className="text-2xl font-bold text-white font-mono">{Object.keys(state.data).length}</div>
                            <div className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold mt-1">Total Keys</div>
                        </div>
                         <div className="bg-slate-800/30 p-3 rounded-lg text-center border border-slate-700/50">
                            <div className="text-2xl font-bold text-blue-400 font-mono">
                                 {(Object.values(state.data) as DataItem[]).reduce((acc, item) => acc + item.size, 0)}<span className="text-sm text-blue-600/70 ml-1">KB</span>
                            </div>
                            <div className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold mt-1">Storage Used</div>
                        </div>
                    </div>
                    {/* Real-time Graph */}
                    <div className="pt-2">
                        <div className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold mb-2">Real-time Load</div>
                        <MetricsGraph data={state.metricsHistory} />
                    </div>
                </div>
            </div>

            <div className="shrink-0 bg-slate-900 rounded-xl border border-cyan-900/70 flex flex-col overflow-hidden shadow-lg">
                <div className="p-3 border-b border-cyan-950/70 bg-cyan-950/20 flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-cyan-200 flex items-center gap-2">
                        <Database size={16} /> Backend State
                    </h2>
                    <div className="flex gap-2">
                        <button
                          onClick={() => loadBackendState()}
                          disabled={backendBusy}
                          className="px-2.5 py-1.5 text-[11px] rounded-md bg-cyan-700/80 hover:bg-cyan-700 text-white disabled:opacity-50 flex items-center gap-1"
                        >
                          <RefreshCw size={12} className={backendBusy ? 'animate-spin' : ''} /> Refresh
                        </button>
                        <button
                          onClick={syncSimulatorNodesToBackend}
                          disabled={backendBusy}
                          className="px-2.5 py-1.5 text-[11px] rounded-md bg-indigo-700/80 hover:bg-indigo-700 text-white disabled:opacity-50"
                        >
                          Sync Nodes
                        </button>
                    </div>
                </div>
                <div className="p-4 space-y-4">
                    <div className="text-xs text-cyan-100/80 bg-slate-950/60 border border-cyan-950/50 rounded-lg p-3 leading-relaxed">
                        {backendStatus}
                    </div>
                    <div className="grid grid-cols-4 gap-3">
                        <div className="bg-slate-800/30 p-3 rounded-lg text-center border border-slate-700/50">
                            <div className="text-2xl font-bold text-white font-mono">{backendState.nodes.length}</div>
                            <div className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold mt-1">DB Nodes</div>
                        </div>
                        <div className="bg-slate-800/30 p-3 rounded-lg text-center border border-slate-700/50">
                            <div className="text-2xl font-bold text-white font-mono">{backendState.dataItems.length}</div>
                            <div className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold mt-1">Items</div>
                        </div>
                        <div className="bg-slate-800/30 p-3 rounded-lg text-center border border-slate-700/50">
                            <div className="text-2xl font-bold text-white font-mono">{backendState.shards.length}</div>
                            <div className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold mt-1">Shards</div>
                        </div>
                        <div className="bg-slate-800/30 p-3 rounded-lg text-center border border-slate-700/50">
                            <div className="text-2xl font-bold text-white font-mono">{backendState.replicas.length}</div>
                            <div className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold mt-1">Replicas</div>
                        </div>
                    </div>
                    <div className="space-y-2 max-h-56 overflow-y-auto">
                        {backendState.nodes.length === 0 ? (
                          <div className="text-xs text-slate-500 border border-dashed border-slate-800 rounded-lg p-3">
                            No backend nodes loaded yet.
                          </div>
                        ) : (
                          backendState.nodes.map((node) => (
                            <div key={node.node_id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-sm font-semibold text-white">{node.node_id}</div>
                                  <div className="text-[11px] text-slate-400">Speed: {node.speed}</div>
                                </div>
                                <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-full ${
                                  node.status === 'active' ? 'bg-emerald-950 text-emerald-400' : 'bg-red-950 text-red-400'
                                }`}>
                                  {node.status}
                                </span>
                              </div>
                              <div className="mt-2 text-[11px] text-slate-400">
                                Storage: {node.used_storage}/{node.capacity}
                              </div>
                              <div className="mt-1 text-[11px] text-slate-400">
                                Remaining Capacity: {node.remaining_capacity}
                              </div>
                              <div className="mt-1 text-[11px] text-slate-400">
                                Utilization: {node.utilization}
                              </div>
                              <div className="mt-1 h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-cyan-500"
                                  style={{ width: `${Math.min(100, node.capacity ? (node.used_storage / node.capacity) * 100 : 0)}%` }}
                                />
                              </div>
                            </div>
                          ))
                        )}
                    </div>
                </div>
            </div>
        </div>
      </main>
    </div>
  );
};

export default App;
