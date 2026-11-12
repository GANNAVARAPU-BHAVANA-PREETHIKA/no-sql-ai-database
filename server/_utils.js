export const parsePositiveInt = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
};

export const requireBody = (body, keys) => {
  const source = body || {};
  const missing = keys.filter((key) => source[key] === undefined || source[key] === null || source[key] === '');

  return {
    body: source,
    missing,
  };
};

export const hashKeyToNode = (key, nodes) => {
  if (!nodes.length) {
    return null;
  }

  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash << 5) - hash + key.charCodeAt(index);
    hash |= 0;
  }

  const slot = Math.abs(hash) % nodes.length;
  return nodes[slot];
};

export const getReplicaNodes = (key, nodes, replicationFactor = 3) => {
  if (!nodes.length) {
    return [];
  }

  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash << 5) - hash + key.charCodeAt(index);
    hash |= 0;
  }

  const startIndex = Math.abs(hash) % nodes.length;
  const selected = [];

  for (let offset = 0; offset < nodes.length && selected.length < replicationFactor; offset += 1) {
    selected.push(nodes[(startIndex + offset) % nodes.length]);
  }

  return selected;
};
