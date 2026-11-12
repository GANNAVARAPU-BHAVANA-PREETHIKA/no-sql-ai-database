import { SystemState, Node, DataItem, NodeStatus, LogEntry } from '../types';

// Simple string hashing to 0-360 degrees
export const consistentHash = (key: string): number => {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
};

// Find the responsible nodes for a key based on ring position
export const findResponsibleNodes = (nodes: Node[], keyHash: number, replicationFactor: number): Node[] => {
  if (nodes.length === 0) return [];
  
  // Sort nodes by angle
  const sortedNodes = [...nodes].sort((a, b) => a.angle - b.angle);
  
  // Find primary node (first node with angle >= keyHash, or wrap around to first node)
  let primaryIndex = sortedNodes.findIndex(n => n.angle >= keyHash);
  if (primaryIndex === -1) primaryIndex = 0;

  const responsible: Node[] = [];
  
  // Walk clockwise to find N unique physical nodes (in a real system, we'd handle vnodes)
  // Here we just take the next N distinct nodes
  for (let i = 0; i < sortedNodes.length; i++) {
    if (responsible.length >= replicationFactor) break;
    const index = (primaryIndex + i) % sortedNodes.length;
    responsible.push(sortedNodes[index]);
  }

  return responsible;
};

// Check if a quorum is met
export const checkQuorum = (nodes: Node[], required: number): boolean => {
  const healthyNodes = nodes.filter(n => n.status === NodeStatus.ONLINE);
  return healthyNodes.length >= required;
};

export const rebalanceData = (state: SystemState): SystemState => {
  const newState = { ...state, data: { ...state.data }, nodes: [...state.nodes] };
  
  // Clear old data mapping on nodes AND reset load
  newState.nodes = newState.nodes.map(n => ({ ...n, dataKeys: [], load: 0 }));

  // Re-calculate placement for all data
  Object.keys(newState.data).forEach(key => {
    const item = newState.data[key];
    const replicas = findResponsibleNodes(newState.nodes, item.hash, newState.config.replicationFactor);
    
    // Update data item
    newState.data[key] = {
      ...item,
      replicas: replicas.map(n => n.id),
      primary: replicas[0]?.id || ''
    };

    // Update nodes
    replicas.forEach(r => {
      const nodeIndex = newState.nodes.findIndex(n => n.id === r.id);
      if (nodeIndex !== -1) {
         // Immutable update for the specific node
         const currentNode = newState.nodes[nodeIndex];
         const updatedNode = { 
           ...currentNode, 
           dataKeys: [...currentNode.dataKeys, key],
           load: currentNode.load + item.size // Recalculate load based on data size
         };
         newState.nodes[nodeIndex] = updatedNode;
      }
    });
  });

  return newState;
};