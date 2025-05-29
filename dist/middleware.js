// src/middleware-helpers.ts
function handleMiddlewareField(init, headers) {
  var _a;
  if ((_a = init == null ? void 0 : init.request) == null ? void 0 : _a.headers) {
    if (!(init.request.headers instanceof Headers)) {
      throw new Error("request.headers must be an instance of Headers");
    }
    const keys = [];
    for (const [key, value] of init.request.headers) {
      headers.set("x-middleware-request-" + key, value);
      keys.push(key);
    }
    headers.set("x-middleware-override-headers", keys.join(","));
  }
}
function rewrite(destination, init) {
  const headers = new Headers((init == null ? void 0 : init.headers) ?? {});
  headers.set("x-middleware-rewrite", String(destination));
  handleMiddlewareField(init, headers);
  return new Response(null, {
    ...init,
    headers
  });
}
function next(init) {
  const headers = new Headers((init == null ? void 0 : init.headers) ?? {});
  headers.set("x-middleware-next", "1");
  handleMiddlewareField(init, headers);
  return new Response(null, {
    ...init,
    headers
  });
}

const config = {
  matcher: "/api/github/webhooks"
};
async function middleware(request) {
  let json;
  try {
    console.log("enter");
    json = await request?.json?.();
  } catch {
    return rewrite(new URL("https://github.com/apps/cr-gpt"));
  }
  if (!json) {
    console.log("received is not a json");
    return rewrite(new URL("https://github.com/apps/cr-gpt"));
  }
  if (!json.before || !json.after || !json.commits) {
    console.log("invalid event");
    return rewrite(new URL("https://github.com/apps/cr-gpt"));
  }
  console.log("GO next");
  return next();
}

export { config, middleware as default };
