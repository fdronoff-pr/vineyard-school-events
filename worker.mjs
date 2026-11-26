export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/events" && url.pathname !== "/events/") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    url.pathname = "/";
    url.search = "";
    return env.ASSETS.fetch(new Request(url, request));
  },
};
