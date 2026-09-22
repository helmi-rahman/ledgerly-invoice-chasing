import { clerkFrontendApiProxy } from "@clerk/backend/proxy";

const PROXY_PATH = "/__clerk";

export default async function handler(request, response) {
  const protocol = request.headers["x-forwarded-proto"] || "https";
  const host = request.headers.host;
  const url = new URL(request.url, `${protocol}://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.toLowerCase() === "host" || name.toLowerCase() === "content-length") continue;
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) headers.set(name, value.join(", "));
  }

  if (!headers.has("origin")) headers.set("Origin", `${protocol}://${host}`);
  let body;
  if (!["GET", "HEAD"].includes(request.method)) {
    const parsedBody = request.body;
    if (typeof parsedBody === "string" || Buffer.isBuffer(parsedBody) || parsedBody instanceof Uint8Array) body = parsedBody;
    else if (parsedBody && typeof parsedBody === "object") {
      body = headers.get("content-type")?.includes("application/json")
        ? JSON.stringify(parsedBody)
        : new URLSearchParams(parsedBody).toString();
    } else body = request;
  }
  const webRequest = new Request(url, {
    method: request.method,
    headers,
    body,
    // @ts-expect-error Node's IncomingMessage is an async iterable request body.
    duplex: "half",
  });
  const proxied = await clerkFrontendApiProxy(webRequest, {
    proxyPath: PROXY_PATH,
    publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
  });

  response.status(proxied.status);
  proxied.headers.forEach((value, name) => {
    if (!['connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) response.setHeader(name, value);
  });
  response.send(Buffer.from(await proxied.arrayBuffer()));
}
