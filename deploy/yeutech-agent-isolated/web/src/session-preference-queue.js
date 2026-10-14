// Serial requests must also share a coherent snapshot: callbacks that capture
// the other control's old value still lose updates even when sent in order.
export function createSessionPreferenceQueue(write) {
  const sessions = new Map();
  return {
    update(id, initial, patch, publish) {
      let entry = sessions.get(id);
      if (!entry) {
        entry = { confirmed: initial, desired: initial, revision: 0, tail: Promise.resolve(), error: null };
        sessions.set(id, entry);
      }
      const snapshot = { ...entry.desired, ...patch };
      const revision = ++entry.revision;
      entry.desired = snapshot;
      publish(snapshot);
      const pending = entry.tail.catch(() => undefined).then(async () => {
        try {
          const result = await write(id, snapshot);
          entry.confirmed = result;
          if (revision === entry.revision) {
            entry.desired = result;
            entry.error = null;
            publish(result, null);
          }
          return result;
        } catch (error) {
          if (revision === entry.revision) {
            entry.desired = entry.confirmed;
            entry.error = error;
            publish(entry.confirmed, error);
          }
          throw error;
        }
      });
      entry.tail = pending;
      return pending;
    },
    async flush(id, initial) {
      const entry = sessions.get(id);
      if (!entry) return initial;
      let pending;
      do {
        pending = entry.tail;
        await pending.catch(() => undefined);
      } while (pending !== entry.tail);
      if (entry.error) throw entry.error;
      return entry.confirmed;
    },
  };
}
