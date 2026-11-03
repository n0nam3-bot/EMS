// One small helper for talking to the server as the signed-in person.
export async function apiRequest(session, method, path, body) {
  const res = await fetch(`${session.apiBaseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (HTTP ${res.status})`);
    err.status = res.status;
    err.conflict = data?.conflict;       // e.g. which existing shift a new one overlaps
    err.missing = data?.missing;
    throw err;
  }
  return data;
}

// Same, for lists the server pages: also returns how many there are in total.
export async function apiRequestPaged(session, path) {
  const res = await fetch(`${session.apiBaseUrl}${path}`, { headers: session.token ? { Authorization: `Bearer ${session.token}` } : {} });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  return { rows: data, total: Number(res.headers.get("X-Total-Count") ?? data.length) };
}
