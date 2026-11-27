const supabaseUrl = "https://gnxdeoqxtbvoirlmltjf.supabase.co";
const publishableKey = "sb_publishable_QszODofxtNdnPvX9tVXfVg__LFSr-_m";
const authCookie = "sb-gnxdeoqxtbvoirlmltjf-auth-token";
const groupCodes = ["YR", "Y1", "Y2", "Y3", "Y4", "Y5", "Y6"];
const eventsTable = "vineyard_events";
const suggestionsTable = "vineyard_suggestions";

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sessionToken(request) {
  const cookies = new Map((request.headers.get("Cookie") ?? "").split(/;\s*/).map(entry => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  let session = cookies.get(authCookie) ?? "";
  if (!session) {
    for (let index = 0; cookies.has(authCookie + "." + index); index++) {
      session += cookies.get(authCookie + "." + index);
    }
  }
  try {
    session = decodeURIComponent(session);
    if (session.startsWith("base64-")) {
      const base64 = session.slice(7).replaceAll("-", "+").replaceAll("_", "/");
      session = new TextDecoder().decode(Uint8Array.from(atob(base64), char => char.charCodeAt(0)));
    }
    const token = JSON.parse(session)?.access_token;
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

async function adminToken(request) {
  const token = sessionToken(request);
  if (!token) return null;
  const response = await fetch(supabaseUrl + "/auth/v1/user", {
    headers: { apikey: publishableKey, Authorization: "Bearer " + token },
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new RequestError(503, "Sign-in is temporarily unavailable.");
  const user = await response.json();
  if (!user.id || !user.email_confirmed_at) return null;
  return await database("rpc/is_vineyard_admin", { token, method: "POST", body: "{}" }) ? token : null;
}

async function database(path, { token, headers, ...options } = {}) {
  const response = await fetch(supabaseUrl + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: publishableKey,
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...headers,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new RequestError(403, "You do not have access to this action.");
    throw new RequestError(503, "Events are temporarily unavailable. Please try again.");
  }
  const content = await response.text();
  return content ? JSON.parse(content) : null;
}

async function allRows(query, token) {
  const entries = [];
  for (let offset = 0; ; offset = entries.length) {
    const records = await database(query + "&limit=500&offset=" + offset, { token });
    if (!records.length) return entries;
    entries.push(...records);
  }
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function redirect(url, path) {
  return new Response(null, { status: 303, headers: { Location: new URL(path, url).href, "Cache-Control": "no-store" } });
}

async function jsonBody(request, url) {
  if (request.headers.get("Origin") !== url.origin) throw new RequestError(403, "Invalid request origin.");
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json" || !request.body) {
    throw new RequestError(415, "Expected a JSON request.");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let value = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new RequestError(413, "The form is too long.");
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
    const body = JSON.parse(value + decoder.decode());
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError();
    return body;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "Invalid form data.");
  }
}

function formDetails(body, isEvent) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const groups = body.year_groups;
  if (!name || name.length > 120 || (!isEvent && !description) || description.length > 2000) {
    throw new RequestError(400, "Enter a valid event name and description.");
  }
  if (!Array.isArray(groups) || groups.length > 7 || (!isEvent && !groups.length) || groups.some(group => !groupCodes.includes(group))) {
    throw new RequestError(400, "Select valid year groups.");
  }
  const details = { name, description, year_groups: groupCodes.filter(group => groups.includes(group)) };
  if (!isEvent) {
    const suggesterName = typeof body.suggester_name === "string" ? body.suggester_name.trim() : "";
    if (suggesterName.length > 120) throw new RequestError(400, "Suggester name must be 120 characters or fewer.");
    return { ...details, suggester_name: suggesterName || null };
  }
  const date = typeof body.event_date === "string" ? body.event_date : "";
  if (!/^202[5-7]-(0[1-6]|09|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)
      || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new RequestError(400, "Choose a valid calendar date outside July and August, between 2025 and 2027.");
  }
  const eventTime = typeof body.event_time === "string" ? body.event_time.trim() : "";
  if (eventTime.length > 80 || !["confirmed", "planned"].includes(body.status)) {
    throw new RequestError(400, "Enter a valid time and status.");
  }
  return { ...details, event_date: date, event_time: eventTime, status: body.status };
}

const eventQuery = eventsTable + "?select=id,event_date,name,event_time,description,year_groups,status&order=event_date,sort_order,created_at,id";
const suggestionQuery = suggestionsTable + "?select=id,name,description,year_groups,suggester_name,created_at&order=created_at.desc,id";
const uuidFormat = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

async function api(request, url, path) {
  const method = request.method;
  if (path === "/api/events" && method === "GET") return json(await allRows(eventQuery));
  if (path === "/api/suggestions" && method === "POST") {
    const details = formDetails(await jsonBody(request, url), false);
    await database(suggestionsTable, { method, body: JSON.stringify(details) });
    return json({ success: true }, 201);
  }
  const resource = /^\/api\/admin\/(events|suggestions)(?:\/([a-f\d-]{36}))?$/.exec(path);
  if (path !== "/api/admin" && !resource) throw new RequestError(404, "Not found.");
  const token = await adminToken(request);
  if (!token) throw new RequestError(403, "Sign in with the authorised administrator account.");
  if (path === "/api/admin" && method === "GET") {
    const [events, suggestions] = await Promise.all([allRows(eventQuery, token), allRows(suggestionQuery, token)]);
    return json({ events, suggestions });
  }
  if (path === "/api/admin/events" && method === "POST") {
    const body = await jsonBody(request, url);
    const details = formDetails(body, true);
    if (body.suggestion_id) {
      if (typeof body.suggestion_id !== "string" || !uuidFormat.test(body.suggestion_id)) throw new RequestError(400, "Invalid suggestion.");
      const published = await database("rpc/publish_vineyard_suggestion", {
        token, method, body: JSON.stringify({ suggestion_id: body.suggestion_id, details }),
      });
      if (!published) throw new RequestError(409, "This suggestion has already been handled.");
    } else {
      await database(eventsTable, { token, method, body: JSON.stringify(details) });
    }
    return json({ success: true }, 201);
  }
  if (resource?.[2] && uuidFormat.test(resource[2]) && method === "DELETE") {
    if (request.headers.get("Origin") !== url.origin) throw new RequestError(403, "Invalid request origin.");
    const table = resource[1] === "events" ? eventsTable : suggestionsTable;
    await database(table + "?id=eq." + resource[2], { token, method });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  throw new RequestError(405, "Method not allowed.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/events" && !url.pathname.startsWith("/events/")) return new Response("Not found", { status: 404 });
    const path = url.pathname.slice("/events".length).replace(/\/$/, "");
    const adminPage = path === "/admin" || path === "/admin/add";
    try {
      if (path.startsWith("/api/")) return await api(request, url, path);
      if (!["", "/suggest", "/login", "/admin", "/admin/add", "/hero-background.jpg"].includes(path)) return new Response("Not found", { status: 404 });
      if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      if (adminPage && !await adminToken(request)) return redirect(url, "/events/login?access=denied");
      if (path === "/login" && !url.searchParams.has("access") && await adminToken(request)) return redirect(url, "/events/admin");
      url.pathname = path === "/hero-background.jpg" ? path : "/";
      url.search = "";
      const assetRequest = new Request(url, request);
      if (adminPage || path === "/login") {
        assetRequest.headers.delete("If-None-Match");
        assetRequest.headers.delete("If-Modified-Since");
      }
      const response = await env.ASSETS.fetch(assetRequest);
      if (adminPage || path === "/login") {
        const privateResponse = new Response(response.body, response);
        privateResponse.headers.set("Cache-Control", "no-store");
        return privateResponse;
      }
      return response;
    } catch (error) {
      if (!(error instanceof RequestError)) console.error("School Events request failed", error.name);
      return json({ error: error instanceof RequestError ? error.message : "Events are temporarily unavailable. Please try again." }, error.status ?? 503);
    }
  },
};
