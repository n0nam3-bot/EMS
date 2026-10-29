// api-client.js
// -----------------------------------------------------------------------
// Deliberately plain JS with no framework dependency — this is what
// gets tested directly in Node against the real running server (see
// tests/api-client.test.js), and what each React console's fetch calls
// are meant to mirror. Written once here instead of separately inside
// every artifact, so there's one place this logic can be wrong instead
// of four.
//
// Uses native fetch — no node-fetch dependency needed, Node 18+ ships
// it built in, same runtime this whole backend already targets.
// -----------------------------------------------------------------------

export function createApiClient({ baseUrl, token }) {
  async function request(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error(data?.error || `Request failed with HTTP ${res.status}`);
      error.status = res.status;
      error.body = data;
      throw error;
    }
    return data;
  }

  return {
    getIncidents: () => request("GET", "/incidents"),
    getIncident: (id) => request("GET", `/incidents/${id}`),
    createIncident: (payload) => request("POST", "/incidents", payload),
    completeIncident: (incidentId) => request("POST", `/incidents/${incidentId}/complete`),
    assignUnit: (incidentId, unitId, role) => request("POST", `/incidents/${incidentId}/assignments`, { unitId, role }),
    releaseUnit: (incidentId, unitId) => request("DELETE", `/incidents/${incidentId}/assignments/${unitId}`),
    getUnits: () => request("GET", "/units"),
    setUnitStatus: (unitId, status) => request("PATCH", `/units/${unitId}/status`, { status }),
    reportLocation: (unitId, payload) => request("PATCH", `/units/${unitId}/location`, payload),
    createMutualAidGrant: (payload) => request("POST", "/mutual-aid/grants", payload),
    revokeMutualAidGrant: (linkId) => request("POST", `/mutual-aid/grants/${linkId}/revoke`),
    getAudit: (params = {}) => request("GET", `/audit?${new URLSearchParams(params)}`),
    verifyAuditChain: () => request("GET", "/audit/verify"),
    getCertifications: () => request("GET", "/certifications"),
    getVehicles: () => request("GET", "/vehicles"),
    createPcr: (incidentId) => request("POST", "/pcr", { incidentId }),
    getPcr: (pcrId) => request("GET", `/pcr/${pcrId}`),
    addVitals: (pcrId, payload) => request("POST", `/pcr/${pcrId}/vitals`, payload),
    addProcedure: (pcrId, payload) => request("POST", `/pcr/${pcrId}/procedures`, payload),
    addMedication: (pcrId, payload) => request("POST", `/pcr/${pcrId}/medications`, payload),
    saveDisposition: (pcrId, payload) => request("PUT", `/pcr/${pcrId}/disposition`, payload),
    saveNarrative: (pcrId, clinicalNarrative) => request("PATCH", `/pcr/${pcrId}/narrative`, { clinicalNarrative }),
  };
}
