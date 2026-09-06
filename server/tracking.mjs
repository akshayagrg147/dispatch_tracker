// Courier provider adapters. This module runs only on the server so the
// tracking API key is never sent to the browser.

function normalise(raw, note = "") {
  const s = String(raw || "").toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
  const has = (...words) => words.some(word => s.includes(word));
  if (has("return", "rto", "refused", "undeliverable", "undelivered")) return { status: "Returned", note };
  if (has("delivered", "signed for", "collected by recipient")) return { status: "Delivered", note };
  if (has("out for delivery", "outfordelivery")) return { status: "In Transit", note: note || "Out for delivery" };
  if (has("transit", "pickup", "picked up", "in progress", "info received", "inforeceived", "available for pickup")) {
    return { status: "In Transit", note };
  }
  if (has("exception", "attempt fail", "attemptfail", "failed attempt", "on hold", "delay")) {
    return { status: "In Transit", note: note || "Delivery problem reported — check with the transporter" };
  }
  if (has("expired", "pending", "notfound", "not found")) return { status: null, note: note || "Courier has not scanned it yet" };
  return { status: null, note };
}

function makeAdapters({ provider, apiKey, baseUrl, authHeader }) {
  const headers = { [authHeader]: apiKey };

  async function afterShipRegister(slug, number) {
    const response = await fetch(`${baseUrl}/trackings`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ tracking: { tracking_number: number, ...(slug ? { slug } : {}) } }),
    });
    if ([200, 201, 409].includes(response.status)) return { ok: true };
    const body = await response.text().catch(() => "");
    if (/4003|4009|already exists|duplicate/i.test(body)) return { ok: true };
    return { ok: false, error: `Provider said ${response.status}: ${body.slice(0, 160)}` };
  }

  async function afterShipFetch(slug, number) {
    const response = await fetch(`${baseUrl}/trackings?tracking_numbers=${encodeURIComponent(number)}${slug ? `&slug=${encodeURIComponent(slug)}` : ""}`, { headers });
    if (!response.ok) return { ok: false, error: `Provider said ${response.status}` };
    const json = await response.json().catch(() => ({}));
    const tracking = json?.data?.trackings?.[0] ?? json?.data?.tracking ?? null;
    if (!tracking) return { ok: true, raw: "", note: "", slug };
    const checkpoints = Array.isArray(tracking.checkpoints) ? tracking.checkpoints : [];
    const last = checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
    return {
      ok: true,
      raw: String(tracking.tag ?? tracking.subtag ?? ""),
      note: [last?.message, last?.location].filter(Boolean).join(" · ").slice(0, 200),
      slug: String(tracking.slug ?? slug ?? ""),
    };
  }

  async function trackingMoreRegister(slug, number) {
    const response = await fetch(`${baseUrl}/trackings/create`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ tracking_number: number, ...(slug ? { courier_code: slug } : {}) }),
    });
    const json = await response.json().catch(() => ({}));
    if (response.ok || json?.meta?.code === 4016) return { ok: true };
    return { ok: false, error: `Provider said ${json?.meta?.code ?? response.status}: ${String(json?.meta?.message ?? "").slice(0, 160)}` };
  }

  async function trackingMoreFetch(slug, number) {
    const response = await fetch(`${baseUrl}/trackings/get?tracking_numbers=${encodeURIComponent(number)}`, { headers });
    if (!response.ok) return { ok: false, error: `Provider said ${response.status}` };
    const json = await response.json().catch(() => ({}));
    const tracking = Array.isArray(json?.data) ? json.data[0] : (json?.data?.[0] ?? null);
    if (!tracking) return { ok: true, raw: "", note: "", slug };
    const info = tracking.origin_info?.trackinfo;
    const last = Array.isArray(info) && info.length ? info[0] : null;
    return {
      ok: true,
      raw: String(tracking.delivery_status ?? tracking.status ?? ""),
      note: [last?.tracking_detail, last?.location].filter(Boolean).join(" · ").slice(0, 200),
      slug: String(tracking.courier_code ?? slug ?? ""),
    };
  }

  return provider === "trackingmore"
    ? { register: trackingMoreRegister, fetchOne: trackingMoreFetch }
    : { register: afterShipRegister, fetchOne: afterShipFetch };
}

function decidePatch(order, result, now = new Date()) {
  const normalised = normalise(result.raw, result.note);
  const patch = {
    tracking_state: result.raw ?? "",
    tracking_note: normalised.note ?? "",
    tracking_slug: result.slug ?? "",
    tracking_checked_at: now.toISOString(),
  };
  const humanSet = order.status_source === "manual" && order.status !== "Dispatched";
  if (normalised.status && !humanSet && normalised.status !== order.status) {
    patch.status = normalised.status;
    patch.status_source = "auto";
    if (normalised.status === "Delivered" && !order.delivery_date) patch.delivery_date = now.toISOString().slice(0, 10);
  }
  return patch;
}

export { decidePatch, makeAdapters };
