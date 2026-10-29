// backend_context.js
// -----------------------------------------------------------------------
// Who is acting, available to the database layer without threading a
// user argument through every call. withTenant() reads it to tell the
// audit triggers who made each change.
//
// The risk with implicit request context is cross-contamination: one
// request's identity leaking into another's. That would be worse than
// recording nobody — it would attribute an action to the WRONG person.
// AsyncLocalStorage follows the async call chain rather than a shared
// variable, and tests/api-client.test.js proves attribution holds with
// 72 concurrent requests from 6 users against a pool of 20 connections.
// -----------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";

export const requestContext = new AsyncLocalStorage();

export function currentUserId() {
  return requestContext.getStore()?.userId ?? null;
}
