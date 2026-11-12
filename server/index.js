import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import supabase, { isSupabaseConfigured } from './_supabase.js';
import { getReplicaNodes, parsePositiveInt, requireBody } from './_utils.js';

dotenv.config({ path: '.env' });
dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4000);
const REPLICATION_FACTOR = 3;
const DEFAULT_SYSTEM_CONFIG = {
  consistency_mode: 'TUNABLE',
  replication_factor: 3,
  read_quorum: 2,
  write_quorum: 2,
};

const isMissingTableError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('relation') && message.includes('does not exist');
};

const normalizeSystemConfig = (rawConfig = {}) => ({
  id: 1,
  consistency_mode: String(rawConfig.consistency_mode || DEFAULT_SYSTEM_CONFIG.consistency_mode),
  replication_factor: Number(rawConfig.replication_factor || DEFAULT_SYSTEM_CONFIG.replication_factor),
  read_quorum: Number(rawConfig.read_quorum || DEFAULT_SYSTEM_CONFIG.read_quorum),
  write_quorum: Number(rawConfig.write_quorum || DEFAULT_SYSTEM_CONFIG.write_quorum),
});

const loadSystemConfig = async () => {
  const { data, error } = await supabase
    .from('system_config')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      return { data: normalizeSystemConfig(DEFAULT_SYSTEM_CONFIG), missingTable: true };
    }

    return { error };
  }

  return { data: normalizeSystemConfig(data || DEFAULT_SYSTEM_CONFIG), missingTable: false };
};

const updateReplicaNodeUsage = async (replicaNodes, sizeDelta) => {
  for (const replicaNode of replicaNodes) {
    const nextUsage = Number(replicaNode.used_storage || 0) + sizeDelta;
    const { error: nodeUpdateError } = await supabase
      .from('nodes')
      .update({ used_storage: Math.max(0, nextUsage) })
      .eq('node_id', replicaNode.node_id);

    if (nodeUpdateError) {
      throw new Error(nodeUpdateError.message);
    }
  }
};

app.use(cors());
app.use(express.json());

app.use('/api', (req, res, next) => {
  if (req.path === '/health') {
    next();
    return;
  }

  if (!isSupabaseConfigured) {
    res.status(500).json({
      error: 'Backend is running, but SUPABASE_URL and SUPABASE_KEY are not configured.',
    });
    return;
  }

  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'nosql-sim-ai-backend', supabaseConfigured: isSupabaseConfigured });
});

app.get('/api/getConfig', async (_req, res) => {
  const result = await loadSystemConfig();
  if (result.error) {
    res.status(500).json({ error: result.error.message, details: result.error.details });
    return;
  }

  res.json({
    config: result.data,
    persisted: !result.missingTable,
  });
});

app.post('/api/updateConfig', async (req, res) => {
  const { body, missing } = requireBody(req.body, ['consistency_mode', 'replication_factor', 'read_quorum', 'write_quorum']);
  if (missing.length) {
    res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    return;
  }

  const allowedModes = ['STRONG', 'EVENTUAL', 'TUNABLE'];
  const consistencyMode = String(body.consistency_mode).trim().toUpperCase();
  if (!allowedModes.includes(consistencyMode)) {
    res.status(400).json({ error: 'consistency_mode must be STRONG, EVENTUAL, or TUNABLE' });
    return;
  }

  const replicationFactor = parsePositiveInt(body.replication_factor);
  const readQuorum = parsePositiveInt(body.read_quorum);
  const writeQuorum = parsePositiveInt(body.write_quorum);

  if (!replicationFactor || !readQuorum || !writeQuorum) {
    res.status(400).json({ error: 'replication_factor, read_quorum, and write_quorum must be positive integers' });
    return;
  }

  if (readQuorum > replicationFactor || writeQuorum > replicationFactor) {
    res.status(400).json({ error: 'read_quorum and write_quorum cannot exceed replication_factor' });
    return;
  }

  const updatePayload = {
    consistency_mode: consistencyMode,
    replication_factor: replicationFactor,
    read_quorum: readQuorum,
    write_quorum: writeQuorum,
    updated_at: new Date().toISOString(),
  };
  const insertPayload = {
    id: 1,
    ...updatePayload,
  };

  let data = null;
  let error = null;

  const existingConfigResult = await supabase
    .from('system_config')
    .select('id')
    .eq('id', 1)
    .maybeSingle();

  if (existingConfigResult.error) {
    res.status(400).json({ error: existingConfigResult.error.message, details: existingConfigResult.error.details });
    return;
  }

  if (existingConfigResult.data) {
    const updateResult = await supabase
      .from('system_config')
      .update(updatePayload)
      .eq('id', 1)
      .select()
      .single();

    data = updateResult.data;
    error = updateResult.error;
  } else {
    const insertResult = await supabase
      .from('system_config')
      .insert([insertPayload])
      .select()
      .single();

    data = insertResult.data;
    error = insertResult.error;
  }

  if (error) {
    res.status(400).json({ error: error.message, details: error.details });
    return;
  }

  const storedConfigResult = await supabase
    .from('system_config')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (storedConfigResult.error) {
    res.status(500).json({ error: storedConfigResult.error.message, details: storedConfigResult.error.details });
    return;
  }

  if (!storedConfigResult.data) {
    res.status(500).json({ error: 'system_config write did not persist a row for id=1' });
    return;
  }

  const historyInsertResult = await supabase
    .from('system_config_history')
    .insert([{
      consistency_mode: storedConfigResult.data.consistency_mode,
      replication_factor: storedConfigResult.data.replication_factor,
      read_quorum: storedConfigResult.data.read_quorum,
      write_quorum: storedConfigResult.data.write_quorum,
      changed_at: new Date().toISOString(),
    }])
    .select()
    .single();

  if (historyInsertResult.error) {
    res.status(500).json({ error: historyInsertResult.error.message, details: historyInsertResult.error.details });
    return;
  }

  res.json({
    message: 'System config updated',
    config: normalizeSystemConfig(storedConfigResult.data),
    stored_row: storedConfigResult.data,
    history_row: historyInsertResult.data,
  });
});

app.post('/api/createNode', async (req, res) => {
  const { body, missing } = requireBody(req.body, ['node_id', 'capacity', 'speed']);
  if (missing.length) {
    res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    return;
  }

  const capacity = parsePositiveInt(body.capacity);
  if (capacity === null) {
    res.status(400).json({ error: 'capacity must be a non-negative integer' });
    return;
  }

  const payload = {
    node_id: String(body.node_id).trim(),
    capacity,
    speed: String(body.speed).trim(),
    status: 'active',
  };

  const { data, error } = await supabase
    .from('nodes')
    .insert([payload])
    .select()
    .single();

  if (error) {
    res.status(400).json({ error: error.message, details: error.details });
    return;
  }

  res.status(201).json({ message: 'Node created', data });
});

app.post('/api/insertData', async (req, res) => {
  const { body, missing } = requireBody(req.body, ['key', 'size', 'value']);
  if (missing.length) {
    res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    return;
  }

  const size = parsePositiveInt(body.size);
  if (size === null || size === 0) {
    res.status(400).json({ error: 'size must be a positive integer' });
    return;
  }

  const key = String(body.key).trim();
  const value = String(body.value);

  const { data: nodes, error: nodesError } = await supabase
    .from('nodes')
    .select('*')
    .eq('status', 'active')
    .order('node_id');

  if (nodesError) {
    res.status(500).json({ error: nodesError.message, details: nodesError.details });
    return;
  }

  if (!nodes?.length) {
    res.status(400).json({ error: 'No active nodes available for shard allocation' });
    return;
  }

  const { data: existingItem, error: existingItemError } = await supabase
    .from('data_items')
    .select('*')
    .eq('item_key', key)
    .maybeSingle();

  if (existingItemError) {
    res.status(500).json({ error: existingItemError.message, details: existingItemError.details });
    return;
  }

  if (existingItem) {
    res.status(400).json({ error: `Key ${key} already exists. Use /api/updateData to modify it.` });
    return;
  }

  const replicaNodes = getReplicaNodes(key, nodes, REPLICATION_FACTOR);
  if (!replicaNodes.length) {
    res.status(400).json({ error: 'Unable to select target nodes' });
    return;
  }

  for (const replicaNode of replicaNodes) {
    const nextUsage = Number(replicaNode.used_storage || 0) + size;
    if (nextUsage > Number(replicaNode.capacity || 0)) {
      res.status(400).json({
        error: `Node ${replicaNode.node_id} does not have enough capacity`,
        assigned_node: replicaNode.node_id,
        remaining_capacity: Number(replicaNode.capacity || 0) - Number(replicaNode.used_storage || 0),
      });
      return;
    }
  }

  const shardId = `S_${key}`;
  const { data: shardData, error: shardError } = await supabase
    .from('shards')
    .insert([{ shard_id: shardId, node_id: replicaNodes[0].node_id, size }])
    .select()
    .single();

  if (shardError) {
    res.status(400).json({ error: shardError.message, details: shardError.details });
    return;
  }

  const { data: dataItem, error: dataItemError } = await supabase
    .from('data_items')
    .insert([{
      item_key: key,
      item_value: value,
      size,
      shard_id: shardId,
    }])
    .select()
    .single();

  if (dataItemError) {
    await supabase.from('shards').delete().eq('shard_id', shardId);
    res.status(500).json({ error: dataItemError.message, details: dataItemError.details });
    return;
  }

  const replicaRows = replicaNodes.map((replicaNode, index) => ({
    shard_id: shardId,
    node_id: replicaNode.node_id,
    type: index === 0 ? 'primary' : 'secondary',
  }));

  const { data: replicaData, error: replicaError } = await supabase
    .from('replicas')
    .insert(replicaRows)
    .select();

  if (replicaError) {
    await supabase.from('data_items').delete().eq('item_key', key);
    await supabase.from('shards').delete().eq('shard_id', shardId);
    res.status(500).json({ error: replicaError.message, details: replicaError.details });
    return;
  }

  try {
    await updateReplicaNodeUsage(replicaNodes, size);
  } catch (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json({
    message: 'Data inserted',
    assigned_node: replicaNodes[0].node_id,
    shard: shardData,
    replicas: replicaData,
    item: dataItem,
  });
});

app.get('/api/readData', async (req, res) => {
  const key = String(req.query.key || '').trim();
  if (!key) {
    res.status(400).json({ error: 'key query parameter is required' });
    return;
  }

  const { data, error } = await supabase
    .from('data_items')
    .select('*')
    .eq('item_key', key)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message, details: error.details });
    return;
  }

  if (!data) {
    res.status(404).json({ error: `Key ${key} not found` });
    return;
  }

  const { data: replicas, error: replicaError } = await supabase
    .from('replicas')
    .select('*')
    .eq('shard_id', data.shard_id)
    .order('id');

  if (replicaError) {
    res.status(500).json({ error: replicaError.message, details: replicaError.details });
    return;
  }

  res.json({ item: data, replicas: replicas || [] });
});

app.post('/api/updateData', async (req, res) => {
  const { body, missing } = requireBody(req.body, ['key', 'value']);
  if (missing.length) {
    res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
    return;
  }

  const key = String(body.key).trim();
  const value = String(body.value);
  const size = parsePositiveInt(body.size ?? Math.max(5, Math.ceil(value.length / 5)));
  if (size === null || size === 0) {
    res.status(400).json({ error: 'size must be a positive integer' });
    return;
  }

  const { data: existingItem, error: existingItemError } = await supabase
    .from('data_items')
    .select('*')
    .eq('item_key', key)
    .maybeSingle();

  if (existingItemError) {
    res.status(500).json({ error: existingItemError.message, details: existingItemError.details });
    return;
  }

  if (!existingItem) {
    res.status(404).json({ error: `Key ${key} not found` });
    return;
  }

  const sizeDelta = size - Number(existingItem.size || 0);
  const { data: replicas, error: replicaError } = await supabase
    .from('replicas')
    .select('node_id')
    .eq('shard_id', existingItem.shard_id);

  if (replicaError) {
    res.status(500).json({ error: replicaError.message, details: replicaError.details });
    return;
  }

  if (sizeDelta > 0) {
    const nodeIds = (replicas || []).map((replica) => replica.node_id);
    const { data: replicaNodes, error: nodesError } = await supabase
      .from('nodes')
      .select('*')
      .in('node_id', nodeIds);

    if (nodesError) {
      res.status(500).json({ error: nodesError.message, details: nodesError.details });
      return;
    }

    for (const replicaNode of replicaNodes || []) {
      const nextUsage = Number(replicaNode.used_storage || 0) + sizeDelta;
      if (nextUsage > Number(replicaNode.capacity || 0)) {
        res.status(400).json({
          error: `Node ${replicaNode.node_id} does not have enough capacity for update`,
          remaining_capacity: Number(replicaNode.capacity || 0) - Number(replicaNode.used_storage || 0),
        });
        return;
      }
    }

    try {
      await updateReplicaNodeUsage(replicaNodes || [], sizeDelta);
    } catch (error) {
      res.status(500).json({ error: error.message });
      return;
    }
  } else if (sizeDelta < 0) {
    const nodeIds = (replicas || []).map((replica) => replica.node_id);
    const { data: replicaNodes, error: nodesError } = await supabase
      .from('nodes')
      .select('*')
      .in('node_id', nodeIds);

    if (nodesError) {
      res.status(500).json({ error: nodesError.message, details: nodesError.details });
      return;
    }

    try {
      await updateReplicaNodeUsage(replicaNodes || [], sizeDelta);
    } catch (error) {
      res.status(500).json({ error: error.message });
      return;
    }
  }

  const { data: updatedShard, error: shardError } = await supabase
    .from('shards')
    .update({ size })
    .eq('shard_id', existingItem.shard_id)
    .select()
    .single();

  if (shardError) {
    res.status(500).json({ error: shardError.message, details: shardError.details });
    return;
  }

  const { data: updatedItem, error: updateError } = await supabase
    .from('data_items')
    .update({
      item_value: value,
      size,
      updated_at: new Date().toISOString(),
    })
    .eq('item_key', key)
    .select()
    .single();

  if (updateError) {
    res.status(500).json({ error: updateError.message, details: updateError.details });
    return;
  }

  res.json({ message: `Key ${key} updated`, item: updatedItem, shard: updatedShard });
});

app.post('/api/deleteData', async (req, res) => {
  const { body, missing } = requireBody(req.body, ['key']);
  if (missing.length) {
    res.status(400).json({ error: 'key is required' });
    return;
  }

  const key = String(body.key).trim();
  const { data: existingItem, error: existingItemError } = await supabase
    .from('data_items')
    .select('*')
    .eq('item_key', key)
    .maybeSingle();

  if (existingItemError) {
    res.status(500).json({ error: existingItemError.message, details: existingItemError.details });
    return;
  }

  if (!existingItem) {
    res.status(404).json({ error: `Key ${key} not found` });
    return;
  }

  const { data: replicas, error: replicaError } = await supabase
    .from('replicas')
    .select('node_id')
    .eq('shard_id', existingItem.shard_id);

  if (replicaError) {
    res.status(500).json({ error: replicaError.message, details: replicaError.details });
    return;
  }

  const nodeIds = (replicas || []).map((replica) => replica.node_id);
  const { data: replicaNodes, error: nodesError } = await supabase
    .from('nodes')
    .select('*')
    .in('node_id', nodeIds);

  if (nodesError) {
    res.status(500).json({ error: nodesError.message, details: nodesError.details });
    return;
  }

  try {
    await updateReplicaNodeUsage(replicaNodes || [], -Number(existingItem.size || 0));
  } catch (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const { error: deleteItemError } = await supabase
    .from('data_items')
    .delete()
    .eq('item_key', key);

  if (deleteItemError) {
    res.status(500).json({ error: deleteItemError.message, details: deleteItemError.details });
    return;
  }

  const { error: deleteShardError } = await supabase
    .from('shards')
    .delete()
    .eq('shard_id', existingItem.shard_id);

  if (deleteShardError) {
    res.status(500).json({ error: deleteShardError.message, details: deleteShardError.details });
    return;
  }

  res.json({ message: `Key ${key} deleted` });
});

app.get('/api/getState', async (_req, res) => {
  const [{ data: nodes, error: nodesError }, { data: shards, error: shardsError }, { data: replicas, error: replicasError }, { data: dataItems, error: dataItemsError }, configResult] = await Promise.all([
    supabase.from('nodes').select('*').order('node_id'),
    supabase.from('shards').select('*').order('shard_id'),
    supabase.from('replicas').select('*').order('id'),
    supabase.from('data_items').select('*').order('item_key'),
    loadSystemConfig(),
  ]);

  const error = nodesError || shardsError || replicasError || dataItemsError || configResult.error;
  if (error) {
    res.status(500).json({ error: error.message, details: error.details });
    return;
  }

  const nodesWithMetrics = (nodes || []).map((node) => {
    const capacity = Number(node.capacity || 0);
    const usedStorage = Number(node.used_storage || 0);
    const remainingCapacity = Math.max(0, capacity - usedStorage);
    const utilization = capacity > 0 ? `${((usedStorage / capacity) * 100).toFixed(2)}%` : '0.00%';

    return {
      ...node,
      remaining_capacity: remainingCapacity,
      utilization,
    };
  });

  res.json({
    nodes: nodesWithMetrics,
    shards,
    replicas,
    dataItems,
    config: configResult.data,
    config_persisted: !configResult.missingTable,
  });
});

app.post('/api/simulateFailure', async (req, res) => {
  const { body, missing } = requireBody(req.body, ['node_id']);
  if (missing.length) {
    res.status(400).json({ error: 'node_id is required' });
    return;
  }

  const nodeId = String(body.node_id).trim();
  const { data, error } = await supabase
    .from('nodes')
    .update({ status: 'failed' })
    .eq('node_id', nodeId)
    .select()
    .single();

  if (error) {
    res.status(400).json({ error: error.message, details: error.details });
    return;
  }

  res.json({ message: `Node ${nodeId} marked as failed`, data });
});

app.post('/api/resetNode', async (req, res) => {
  const { body, missing } = requireBody(req.body, ['node_id']);
  if (missing.length) {
    res.status(400).json({ error: 'node_id is required' });
    return;
  }

  const nodeId = String(body.node_id).trim();
  const { data, error } = await supabase
    .from('nodes')
    .update({ status: 'active' })
    .eq('node_id', nodeId)
    .select()
    .single();

  if (error) {
    res.status(400).json({ error: error.message, details: error.details });
    return;
  }

  res.json({ message: `Node ${nodeId} restored`, data });
});

app.listen(port, () => {
  console.log(`Backend API running on http://localhost:${port}`);
});
