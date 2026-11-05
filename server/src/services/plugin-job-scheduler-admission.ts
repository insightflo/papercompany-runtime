/** Process-local admission generations and scheduler DB-operation drains. */
export interface SchedulerAdmissionSnapshot {
  generation: number;
  plugins: ReadonlyMap<string, number>;
  operationRoot: number;
}

export function createSchedulerAdmission() {
  let closed = false;
  let generation = 0;
  let nextOperationRoot = 0;
  const pluginVersions = new Map<string, number>();
  const revoked = new Set<string>();
  type Operation = { root: number; settled: Promise<void>; identity?: Promise<string | undefined> };
  const operations = new Set<Operation>();
  const pluginOperations = new Map<string, Set<Operation>>();
  const unresolved = new Set<Operation>();
  const registrations = new Map<string, { version: number; ready: Promise<void> }>();

  function track(snapshot: SchedulerAdmissionSnapshot, pluginId?: string, lookup = false) {
    let resolve!: () => void;
    let identify: ((id: string | undefined) => void) | undefined;
    const operation: Operation = {
      root: snapshot.operationRoot,
      settled: new Promise<void>((done) => { resolve = done; }),
      ...(lookup ? { identity: new Promise<string | undefined>((done) => { identify = done; }) } : {}),
    };
    operations.add(operation);
    if (lookup) unresolved.add(operation);
    let boundPlugin: string | undefined;
    const bind = (id: string) => {
      if (boundPlugin) throw new Error("scheduler_operation_already_bound");
      boundPlugin = id;
      const pending = pluginOperations.get(id) ?? new Set<Operation>();
      pending.add(operation);
      pluginOperations.set(id, pending);
      unresolved.delete(operation);
      identify?.(id);
    };
    if (pluginId) bind(pluginId);
    return {
      bind,
      done() {
        operations.delete(operation);
        unresolved.delete(operation);
        identify?.(undefined);
        if (boundPlugin) {
          const pending = pluginOperations.get(boundPlugin);
          pending?.delete(operation);
          if (!pending?.size) pluginOperations.delete(boundPlugin);
        }
        resolve();
      },
    };
  }

  const pendingPlugin = (pluginId: string) => [...(pluginOperations.get(pluginId) ?? [])];
  function waitForPlugin(pluginId: string) {
    const roots = new Set(pendingPlugin(pluginId).map((operation) => operation.root));
    const lookups = [...unresolved];
    return (async () => {
      await Promise.all(lookups.map(async (operation) => {
        if (await operation.identity === pluginId) roots.add(operation.root);
      }));
      for (;;) {
        const pending = pendingPlugin(pluginId).filter((operation) => roots.has(operation.root));
        if (!pending.length) return;
        await Promise.all(pending.map((operation) => operation.settled));
      }
    })();
  }
  const pluginValid = (snapshot: SchedulerAdmissionSnapshot, pluginId: string) =>
    !revoked.has(pluginId) && (snapshot.plugins.get(pluginId) ?? 0) === (pluginVersions.get(pluginId) ?? 0);
  const valid = (snapshot: SchedulerAdmissionSnapshot, pluginId: string) =>
    !closed && snapshot.generation === generation && pluginValid(snapshot, pluginId);

  function enter(pluginId?: string, lookup = false) {
    if (closed) return null;
    const snapshot = { generation, plugins: new Map(pluginVersions), operationRoot: ++nextOperationRoot };
    return { snapshot, ...track(snapshot, pluginId, lookup) };
  }

  return {
    enter,
    enterLookup: () => enter(undefined, true),
    enterPlugin(snapshot: SchedulerAdmissionSnapshot, pluginId: string) {
      return valid(snapshot, pluginId) ? track(snapshot, pluginId) : null;
    },
    valid,
    pluginValid,
    close() { closed = true; generation++; },
    reopen() { if (closed) { closed = false; generation++; } },
    isClosed: () => closed,
    revoke(pluginId: string) {
      revoked.add(pluginId);
      pluginVersions.set(pluginId, (pluginVersions.get(pluginId) ?? 0) + 1);
    },
    register(pluginId: string) {
      const current = registrations.get(pluginId);
      if (current && current.version === pluginVersions.get(pluginId)) return current.ready;
      if (!revoked.has(pluginId)) return Promise.resolve();
      const version = (pluginVersions.get(pluginId) ?? 0) + 1;
      pluginVersions.set(pluginId, version);
      const ready = waitForPlugin(pluginId).then(() => {
        if (pluginVersions.get(pluginId) === version) revoked.delete(pluginId);
        if (registrations.get(pluginId)?.version === version) registrations.delete(pluginId);
      });
      registrations.set(pluginId, { version, ready });
      return ready;
    },
    async drain(pluginId?: string) {
      if (pluginId) return waitForPlugin(pluginId);
      for (;;) {
        const pending = [...operations].map((operation) => operation.settled);
        if (!pending.length) return;
        await Promise.all(pending);
      }
    },
  };
}
