// The consoles were written against `window.storage`, a small key-value API
// that exists only inside Claude's preview. Anywhere else it is undefined,
// and the dispatch console calls it on every render — without this, the
// page is blank.
//
// sessionStorage, not localStorage, on purpose: the dispatch console saves
// the API token it's given into this store (a development convenience), and
// a token that survives closing the tab is a bigger exposure than losing a
// little demo state. Replace the pasted-token flow with real sign-in before
// real use; then this store holds nothing sensitive.
if (typeof window !== "undefined" && !window.storage) {
  const P = "ems:";
  window.storage = {
    async get(key) {
      const v = sessionStorage.getItem(P + key);
      if (v === null) throw new Error("not found: " + key);
      return { key, value: v, shared: false };
    },
    async set(key, value) {
      sessionStorage.setItem(P + key, value);
      return { key, value, shared: false };
    },
    async delete(key) {
      sessionStorage.removeItem(P + key);
      return { key, deleted: true, shared: false };
    },
    async list(prefix = "") {
      const keys = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k.startsWith(P + prefix)) keys.push(k.slice(P.length));
      }
      return { keys, prefix, shared: false };
    },
  };
}
