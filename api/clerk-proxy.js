const PROXY_URL = "https://invoice-chasing.vercel.app/__clerk";
const CLERK_FRONTEND_API = "https://frontend-api.clerk.dev";

export default async function handler(request, response) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    response.status(500).json({ error: "Clerk proxy is not configured" });
    return;
  }

  const incomingUrl = new URL(request.url, `https://${request.headers.host}`);
  const rawPath = request.query?.path;
  const path = typeof rawPath === "string"
    ? rawPath
    : Array.isArray(rawPath) && rawPath.every((item) => typeof item === "string")
      ? rawPath.join("/")
      : incomingUrl.searchParams.get("path") || "";
  const target = new URL(`${CLERK_FRONTEND_API}/${path}`);
  for (const [key, value] of incomingUrl.searchParams) {
    if (key !== "path" && key !== "query") target.searchParams.append(key, value);
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.toLowerCase() === "host" || name.toLowerCase() === "content-length") continue;
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) headers.set(name, value.join(", "));
  }
  headers.set("Accept-Encoding", "identity");
  headers.set("Clerk-Proxy-Url", PROXY_URL);
  headers.set("Clerk-Secret-Key", secretKey);
  const forwardedFor = request.headers["x-forwarded-for"] || request.headers["x-real-ip"];
  if (typeof forwardedFor === "string") headers.set("X-Forwarded-For", forwardedFor);
  else if (Array.isArray(forwardedFor) && typeof forwardedFor[0] === "string") headers.set("X-Forwarded-For", forwardedFor[0]);

  let body;
  if (!["GET", "HEAD"].includes(request.method)) {
    if (typeof request.body === "string" || request.body instanceof Uint8Array || request.body instanceof ArrayBuffer) body = request.body;
    else if (request.body && typeof request.body === "object") body = new URLSearchParams(request.body).toString();
  }
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
    duplex: "half",
  });

  response.status(upstream.status);
  upstream.headers.forEach((value, name) => {
    if (!['connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) response.setHeader(name, value);
  });
  response.send(Buffer.from(await upstream.arrayBuffer()));
}
